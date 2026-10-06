#!/usr/bin/env python3
"""The Zabbix template files we ship, checked against what Zabbix 7.0 will accept.

    python3 tools/check-zabbix-templates.py

Two mistakes got as far as an operator's import dialog, and neither needed Zabbix to
find — only the file:

  • triggers under a template. They belong to /zabbix_export (indent 2) or to one item
    (inside items:), never to the template itself: Zabbix answers "unexpected tag
    triggers" and imports nothing.
  • priority: INFORMATION. The constant is INFO, and the import stops on the first one.

Standard library only, and no YAML parser: these are indentation and constant checks, and
the files are generated with a fixed shape.
"""
import glob, os, re, sys

PRIORITIES = {"NOT_CLASSIFIED", "INFO", "WARNING", "AVERAGE", "HIGH", "DISASTER"}
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATTERNS = ["deploy/zabbix/template-*.yaml", "integration/zabbix/**/*.yaml"]

def main() -> int:
    files = sorted({f for p in PATTERNS for f in glob.glob(os.path.join(ROOT, p), recursive=True)})
    if not files:
        print("no template files found — has the layout changed?", file=sys.stderr)
        return 1
    bad = 0
    for path in files:
        rel = os.path.relpath(path, ROOT)
        for n, line in enumerate(open(path, encoding="utf-8"), 1):
            m = re.match(r"^( *)triggers:\s*$", line)
            if m:
                indent = len(m.group(1))
                # 2 = /zabbix_export/triggers. 10 or deeper = inside an item, which Zabbix
                # also takes. 6 is the template itself, which it does not.
                if indent not in (2,) and indent < 8:
                    print(f"{rel}:{n}: triggers at indent {indent} — a template cannot hold "
                          f"triggers; move the block to indent 2 (/zabbix_export/triggers)")
                    bad += 1
            m = re.match(r"^ *priority: *([A-Za-z_]+)\s*$", line)
            if m and m.group(1) not in PRIORITIES:
                print(f"{rel}:{n}: priority {m.group(1)} is not a Zabbix constant "
                      f"({', '.join(sorted(PRIORITIES))})")
                bad += 1
    print(f"{'✗' if bad else 'ok:'} {len(files)} template file(s) checked"
          + (f", {bad} problem(s)" if bad else ", no problems"))
    return 1 if bad else 0

if __name__ == "__main__":
    sys.exit(main())
