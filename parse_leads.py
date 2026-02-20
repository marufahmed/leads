#!/usr/bin/env python3
"""
Script to parse crunchbase-leads.md and convert to JSON format,
sorted by Crunchbase Rank (lowest number = most prominent).

Each block in the markdown (separated by blank lines) follows this structure
after stripping the "[Name] Logo" header line:

  [Name]              <- always first
  [Funding Stage]     <- optional  e.g. "Pre-Seed" (skip / omit)
  [Location]          <- City, State, Country  (3+ comma-separated parts)
  [Industries]        <- comma-separated list, or "—" when missing
  [Description]       <- free-form sentence
  [Rank A]            <- integer formatted as "1,234"  (CrunchBase Org rank)
  [Rank B]            <- optional second integer       (CrunchBase Company rank)

When two ranks are present we keep the lower one (better prominence).

Known noise lines that must be skipped:
  - "<Name> Logo"   — image label
  - pagination markers: "101-150", "of 1,000 results", "Quick add company"
  - header row: "Organization Name", "Headquarters", …
"""

import json
import re
from typing import Any

# ── patterns ──────────────────────────────────────────────────────────────────
RANK_RE      = re.compile(r'^[\d,]+$')
LOGO_RE      = re.compile(r'.+\s+Logo$')
RANGE_RE     = re.compile(r'^\d+-\d+$')          # pagination range e.g. "101-150"
NOISE_TOKENS = {'of 1,000 results', 'quick add company'}

# Known funding-stage tokens that can appear as the second line of a block
FUNDING_STAGES = {
    'pre-seed', 'seed', 'series a', 'series b', 'series c',
    'series d', 'series e', 'angel', 'grant', 'debt financing',
    'convertible note', 'equity crowdfunding', 'post-ipo', 'ipo',
    'secondary market', 'corporate round', 'non-equity assistance',
    'undisclosed',
}


# ── helpers ───────────────────────────────────────────────────────────────────

def is_rank(line: str) -> bool:
    return bool(RANK_RE.match(line.strip()))


def is_location(line: str) -> bool:
    """
    Locations look like "City, State, Country".
    We require ≥3 comma-separated, non-empty parts, with the last part
    being a recognisable country or common US-state variant.
    """
    parts = [p.strip() for p in line.split(',')]
    if len(parts) < 3 or not all(parts):
        return False
    last = parts[-1].lower()
    return any(token in last for token in (
        'united states', 'canada', 'united kingdom', 'australia',
        'germany', 'france', 'india', 'netherlands', 'singapore',
        'israel', 'sweden', 'switzerland', 'spain', 'brazil',
        'mexico', 'japan', 'south korea', 'new zealand', 'ireland',
    ))


def is_noise(line: str) -> bool:
    """Return True for pagination / UI artefact lines."""
    low = line.strip().lower()
    return (
        LOGO_RE.match(line)
        or RANGE_RE.match(low)
        or low in NOISE_TOKENS
        or low.endswith('results')
    )


def is_funding_stage(line: str) -> bool:
    return line.strip().lower() in FUNDING_STAGES


# ── block parser ──────────────────────────────────────────────────────────────

def extract_company(raw_lines: list[str]) -> dict[str, Any] | None:
    # Strip noise / logo lines
    lines = [l.strip() for l in raw_lines if l.strip() and not is_noise(l.strip())]

    if not lines:
        return None

    name = lines[0]

    # Skip header row and rank-only / dash-only openers
    if name in ('—', '') or is_rank(name) or 'Organization Name' in name:
        return None

    rest = lines[1:]

    # ── Assign slots in strict field order ───────────────────────────────────
    # Order:  [funding_stage?]  location  industries  description  rank(s)
    #
    # Strategy: walk lines and assign to the next expected slot.
    # Lines that look like ranks are collected separately.
    # A "—" dash means the current non-rank slot is explicitly empty → skip it.

    ranks: list[int] = []

    funding_stage : str | None = None
    location      : str | None = None
    industries_raw: str | None = None   # raw string, split later
    desc_parts    : list[str]  = []     # may be split across wrapped lines

    # Slot order we step through after collecting ranks
    SLOT_FUNDING = 0
    SLOT_LOCATION = 1
    SLOT_INDUSTRIES = 2
    SLOT_DESCRIPTION = 3
    SLOT_DONE = 4

    slot = SLOT_FUNDING

    for line in rest:
        if is_rank(line):
            ranks.append(int(line.replace(',', '')))
            continue

        if line == '—':
            # Explicit empty marker — advance past the current non-rank slot
            if slot == SLOT_FUNDING:
                slot = SLOT_LOCATION
            elif slot == SLOT_LOCATION:
                slot = SLOT_INDUSTRIES
            elif slot == SLOT_INDUSTRIES:
                slot = SLOT_DESCRIPTION
            continue

        # Try to fit into current or later slots
        if slot == SLOT_FUNDING:
            if is_funding_stage(line):
                funding_stage = line
                slot = SLOT_LOCATION
            elif is_location(line):
                location = line
                slot = SLOT_INDUSTRIES
            else:
                # Not a funding stage or location — treat as industries
                industries_raw = line
                slot = SLOT_DESCRIPTION

        elif slot == SLOT_LOCATION:
            if is_location(line):
                location = line
                slot = SLOT_INDUSTRIES
            elif is_funding_stage(line):
                funding_stage = line   # appeared late; keep waiting for location
            else:
                # No location present — treat as industries
                industries_raw = line
                slot = SLOT_DESCRIPTION

        elif slot == SLOT_INDUSTRIES:
            industries_raw = line
            slot = SLOT_DESCRIPTION

        elif slot == SLOT_DESCRIPTION:
            desc_parts.append(line)   # collect; may be line-wrapped

        # SLOT_DONE: ignore trailing lines

    if not ranks:
        return None   # no rank → not a valid lead

    # Merge wrapped description parts into one string
    description = ' '.join(desc_parts).strip() or None

    # ── Build output ─────────────────────────────────────────────────────────
    company: dict[str, Any] = {'name': name}

    if industries_raw and industries_raw != '—':
        company['industries'] = [i.strip() for i in industries_raw.split(',') if i.strip()]
    if location:
        company['location'] = location
    if description:
        company['description'] = description
    if funding_stage:
        company['funding_stage'] = funding_stage
    company['crunchbase_rank'] = min(ranks)

    return company


# ── file parser ───────────────────────────────────────────────────────────────

def parse_leads_file(filepath: str) -> list[dict[str, Any]]:
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # Each entry is separated by one or more blank lines
    raw_blocks = re.split(r'\n{2,}', content.strip())

    # name → best (lowest) company dict seen so far
    seen: dict[str, dict[str, Any]] = {}
    skipped = 0

    for block in raw_blocks:
        raw_lines = block.splitlines()
        company   = extract_company(raw_lines)
        if company:
            name = company['name']
            if name not in seen or company['crunchbase_rank'] < seen[name]['crunchbase_rank']:
                seen[name] = company
        else:
            skipped += 1

    companies = list(seen.values())

    # Sort ascending — lower rank = more prominent
    companies.sort(key=lambda x: x['crunchbase_rank'])

    dupes = sum(1 for b in raw_blocks
                if (lines := [l.strip() for l in b.splitlines() if l.strip()])
                and lines and not is_noise(lines[0]) and not is_rank(lines[0].strip()))
    print(f"  Parsed  : {len(companies)} unique companies")
    print(f"  Skipped : {skipped} blocks (headers / noise / invalid)")
    return companies


# ── entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    input_file  = 'crunchbase-leads.md'
    output_file = 'leads.json'

    print(f"Parsing {input_file} …")
    companies = parse_leads_file(input_file)

    output = {'total': len(companies), 'companies': companies}

    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"✓ Saved {len(companies)} entries → {output_file}")

    print("\nTop 10 by CB rank:")
    for i, c in enumerate(companies[:10], 1):
        rank = c.get('crunchbase_rank', 'N/A')
        loc  = c.get('location', 'unknown location')
        print(f"  {i:>2}. [{rank:>6}] {c['name']}  —  {loc}")


if __name__ == '__main__':
    main()
