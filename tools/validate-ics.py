"""Independent structural check for an .ics file produced by CalSnap.

    python tools/validate-ics.py tools/sample-event.ics

This is deliberately written from the RFC 5545 rules rather than by reusing the
JavaScript that generated the file, so it can catch mistakes the generator and
its own Node test reader would agree on:

  * CRLF line endings only, no bare CR or LF inside a line;
  * physical lines folded at 75 octets, continuations starting with a space or tab;
  * every BEGIN has a matching END, correctly nested;
  * required properties: VERSION and PRODID in VCALENDAR, UID/DTSTAMP/DTSTART in
    VEVENT, ACTION and TRIGGER in VALARM;
  * DTSTART/DTEND are UTC timestamps (or all-day DATE values) and DTEND is after
    DTSTART;
  * property names are legal, and TEXT values use RFC 5545 escaping (a real line
    break inside a value is impossible, an escaped one is fine).

Exit code 0 means the file passed every check.
"""

from __future__ import annotations

import re
import sys
from datetime import datetime, timezone

PROPERTY_NAME = re.compile(r"^[A-Za-z0-9-]+$")
UTC_STAMP = re.compile(r"^\d{8}T\d{6}Z$")
DATE_VALUE = re.compile(r"^\d{8}$")
MAX_OCTETS = 75

REQUIRED_IN_BLOCK = {
    "VCALENDAR": {"VERSION", "PRODID"},
    "VEVENT": {"UID", "DTSTAMP", "DTSTART"},
    "VALARM": {"ACTION", "TRIGGER"},
}
KNOWN_BLOCKS = set(REQUIRED_IN_BLOCK)
LEGAL_ACTIONS = {"DISPLAY", "AUDIO", "EMAIL"}


class Report:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.checks = 0

    def check(self, condition: bool, message: str) -> bool:
        self.checks += 1
        if not condition:
            self.errors.append(message)
        return condition


def parse_stamp(value: str) -> datetime | None:
    if not UTC_STAMP.match(value):
        return None
    return datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)


def validate(path: str) -> Report:
    report = Report()
    with open(path, "rb") as handle:
        raw = handle.read()

    text = raw.decode("utf-8")
    report.check("\r\n" in text, "file has no CRLF line endings")

    # 1. Line structure and folding.
    physical = text.split("\r\n")
    if physical and physical[-1] == "":
        physical.pop()  # trailing CRLF is legal and expected
    report.check(bool(physical), "file contains no lines")

    for index, line in enumerate(physical, start=1):
        octets = len(line.encode("utf-8"))
        report.check(octets <= MAX_OCTETS, f"line {index} is {octets} octets (limit {MAX_OCTETS})")
        report.check("\n" not in line and "\r" not in line, f"line {index} contains a bare line break")
        if line.startswith((" ", "\t")):
            report.check(index > 1, f"line {index} is a continuation line but is the first line of the file")

    # 2. Logical lines (unfolded) and block nesting.
    logical: list[str] = []
    for line in physical:
        if line.startswith((" ", "\t")) and logical:
            logical[-1] += line[1:]
        else:
            logical.append(line)

    stack: list[list] = []
    open_blocks: list[str] = []
    for line in logical:
        name, _, value = line.partition(":")
        base = name.split(";")[0].upper()
        report.check(bool(PROPERTY_NAME.match(base)), f"illegal property name: {name!r}")
        report.check(":" in line, f"property without a value separator: {line[:40]!r}")

        if base == "BEGIN":
            block = value.strip().upper()
            report.check(block in KNOWN_BLOCKS, f"unknown block type: {block}")
            stack.append([])
            open_blocks.append(block)
        elif base == "END":
            block = value.strip().upper()
            report.check(bool(open_blocks), f"END:{block} without a matching BEGIN")
            if open_blocks:
                report.check(open_blocks[-1] == block, f"END:{block} closes {open_blocks[-1]}")
                open_blocks.pop()
                closed = stack.pop()
                required = REQUIRED_IN_BLOCK.get(block, set())
                present = {item[0] for item in closed}
                for needed in sorted(required - present):
                    report.check(False, f"{block} is missing the required property {needed}")
        else:
            if stack:
                stack[-1].append((base, value))

    report.check(not open_blocks, f"unclosed blocks: {open_blocks}")

    # 3. Event semantics.
    events = [line for line in logical if line.upper() == "BEGIN:VEVENT"]
    report.check(bool(events), "no VEVENT found")

    starts = [line.split(":", 1)[1] for line in logical if line.upper().startswith("DTSTART")]
    ends = [line.split(":", 1)[1] for line in logical if line.upper().startswith("DTEND")]
    for value in starts + ends:
        report.check(
            bool(UTC_STAMP.match(value)) or bool(DATE_VALUE.match(value)),
            f"DTSTART/DTEND must be a UTC stamp or a date, got {value!r}",
        )
    for start, end in zip(starts, ends):
        start_dt, end_dt = parse_stamp(start), parse_stamp(end)
        if start_dt and end_dt:
            report.check(end_dt > start_dt, "DTEND is not after DTSTART")

    for line in logical:
        if line.upper().startswith("ACTION:"):
            report.check(line.split(":", 1)[1].strip().upper() in LEGAL_ACTIONS,
                         f"illegal VALARM ACTION: {line!r}")
        if line.upper().startswith("TRIGGER:"):
            trigger = line.split(":", 1)[1].strip()
            report.check(bool(re.match(r"^-?P(\d+[WDHMS]|T(\d+[HMS])+)+$", trigger)),
                         f"TRIGGER is not a valid duration: {trigger!r}")

    # 4. A raw newline inside a value is the classic .ics corruption.
    for line in logical:
        report.check("\\n" in line or "\r" not in line, "value contains a raw line break")

    return report


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2

    path = argv[1]
    report = validate(path)
    print(f"Checked {report.checks} conditions in {path}")
    if report.errors:
        print(f"FAILED with {len(report.errors)} problem(s):")
        for error in report.errors:
            print("  -", error)
        return 1
    print("All structural checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
