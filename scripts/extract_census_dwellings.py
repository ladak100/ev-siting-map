"""One-time extraction: pulls the specific census characteristics needed for
the Area Overview FSA layers (dwelling counts, dwelling structural type,
median household income) for every Canadian FSA out of the ~645MB raw
StatsCan Census Profile file, into a small CSV that actually gets committed
to the repo.

Run manually, once — NOT part of the automated monthly refresh, since the
~645MB source file isn't something we fetch or commit (2021 census data
won't change before the 2026 census, so there's nothing to refresh anyway).

Expects the raw file at 2021-Census-Data/98-401-X2021013_English_CSV_data.csv
(download page: https://www150.statcan.gc.ca/n1/en/catalogue/98-401-X2021013)

Characteristic IDs below and the "which denominator" choice were validated
against evindex.ca's own displayed numbers for two test FSAs (M5V, L6R) —
see the ev-siting-map-architecture.md discussion. Notably: "Total private dwellings"
(ID 4, includes vacant/seasonal units), not "occupied private dwellings"
(ID 5, actual households), is what matches evindex's EV-adoption denominator
despite their methodology page saying "household count".
"""

import csv
from pathlib import Path

RAW_CSV_PATH = Path(__file__).parent.parent / "2021-Census-Data" / "98-401-X2021013_English_CSV_data.csv"
OUTPUT_PATH = Path(__file__).parent / "data" / "census_dwellings_by_fsa.csv"

CHAR_TOTAL_PRIVATE_DWELLINGS = 4  # incl. vacant/seasonal - EV adoption % denominator
CHAR_OCCUPIED_BY_TYPE_TOTAL = 41  # denominator for the structural-type breakdown
CHAR_SINGLE_DETACHED = 42
CHAR_SEMI_DETACHED = 43
CHAR_ROW_HOUSE = 44
CHAR_APT_DUPLEX = 45
CHAR_APT_LT5 = 46
CHAR_APT_5PLUS = 47
CHAR_OTHER_SINGLE_ATTACHED = 48  # counts toward "houses & townhomes", validated against evindex.ca
CHAR_MOVABLE = 49
CHAR_MEDIAN_HOUSEHOLD_INCOME = 243  # "Median total income of household in 2020 ($)"

WANTED_IDS = {
    CHAR_TOTAL_PRIVATE_DWELLINGS,
    CHAR_OCCUPIED_BY_TYPE_TOTAL,
    CHAR_SINGLE_DETACHED,
    CHAR_SEMI_DETACHED,
    CHAR_ROW_HOUSE,
    CHAR_APT_DUPLEX,
    CHAR_APT_LT5,
    CHAR_APT_5PLUS,
    CHAR_OTHER_SINGLE_ATTACHED,
    CHAR_MOVABLE,
    CHAR_MEDIAN_HOUSEHOLD_INCOME,
}

FIELDNAMES = [
    "fsa",
    "total_private_dwellings",
    "occupied_by_type_total",
    "single_detached",
    "semi_detached",
    "row_house",
    "apt_duplex",
    "apt_lt5",
    "apt_5plus",
    "other_single_attached",
    "movable",
    "median_income",
]

# Column indices in the raw file, per 98-401-X2021013_English_meta.txt's record layout
COL_ALT_GEO_CODE = 2
COL_CHARACTERISTIC_ID = 8
COL_COUNT_TOTAL = 11


def extract() -> dict[str, dict[int, int | None]]:
    by_fsa: dict[str, dict[int, int | None]] = {}

    with open(RAW_CSV_PATH, encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.reader(f)
        next(reader)  # header
        for row in reader:
            char_id = int(row[COL_CHARACTERISTIC_ID])
            if char_id not in WANTED_IDS:
                continue
            fsa = row[COL_ALT_GEO_CODE]
            value = row[COL_COUNT_TOTAL]
            if char_id == CHAR_MEDIAN_HOUSEHOLD_INCOME:
                # StatsCan suppresses this for low-population FSAs (confidentiality) —
                # leave it as None rather than defaulting to 0, which would read as
                # "$0 median income" instead of "not available".
                by_fsa.setdefault(fsa, {})[char_id] = int(value) if value else None
            else:
                by_fsa.setdefault(fsa, {})[char_id] = int(value) if value else 0

    return by_fsa


def main() -> None:
    by_fsa = extract()
    if not by_fsa:
        raise ValueError("Extracted zero FSAs — check RAW_CSV_PATH and column indices")

    OUTPUT_PATH.parent.mkdir(exist_ok=True)
    with open(OUTPUT_PATH, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(FIELDNAMES)
        for fsa, chars in sorted(by_fsa.items()):
            median_income = chars.get(CHAR_MEDIAN_HOUSEHOLD_INCOME)
            writer.writerow(
                [
                    fsa,
                    chars.get(CHAR_TOTAL_PRIVATE_DWELLINGS, 0),
                    chars.get(CHAR_OCCUPIED_BY_TYPE_TOTAL, 0),
                    chars.get(CHAR_SINGLE_DETACHED, 0),
                    chars.get(CHAR_SEMI_DETACHED, 0),
                    chars.get(CHAR_ROW_HOUSE, 0),
                    chars.get(CHAR_APT_DUPLEX, 0),
                    chars.get(CHAR_APT_LT5, 0),
                    chars.get(CHAR_APT_5PLUS, 0),
                    chars.get(CHAR_OTHER_SINGLE_ATTACHED, 0),
                    chars.get(CHAR_MOVABLE, 0),
                    median_income if median_income is not None else "",
                ]
            )

    print(f"Wrote {len(by_fsa)} FSAs to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
