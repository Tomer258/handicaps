"""Rollback-compatibility lint for EF Core migrations (runbooks/rollback.md).

A release may be rolled back only to code that still works against the new schema. That holds when every migration's
Up() is "expand only": new tables, new nullable columns or columns with a database default, new indexes. Anything that
removes, renames or narrows something the previous release reads or writes breaks a rollback.

Flags in Up():
  DropTable / DropColumn / RenameTable / RenameColumn / AlterColumn / DropPrimaryKey / DropUniqueConstraint
  AddColumn with nullable: false and no defaultValue / defaultValueSql (the old code's INSERTs would fail)
  raw Sql(...) containing DROP TABLE / DROP COLUMN / RENAME / ALTER COLUMN / SET NOT NULL

A migration that must break compatibility says so in a comment, `// rollback-incompatible: <why>`; it is then listed
(not failed) so the release notes can say "restore the pre-release backup to roll back".

Usage: python -I infra/scripts/check-migrations.py [migrations-dir]      (exit 1 on unmarked findings)
       python -I infra/scripts/check-migrations.py --self-test
"""

import os
import re
import sys

DEFAULT_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "apps", "api", "src", "Hangar.Core", "Persistence", "Migrations")
BASELINE = {"Initial"}  # nothing to roll back to before the first migration

DESTRUCTIVE_CALLS = ["DropTable", "DropColumn", "RenameTable", "RenameColumn", "AlterColumn", "DropPrimaryKey", "DropUniqueConstraint"]
RAW_SQL = re.compile(r"\b(DROP\s+TABLE|DROP\s+COLUMN|RENAME\s|ALTER\s+COLUMN|SET\s+NOT\s+NULL)", re.IGNORECASE)
MARKER = re.compile(r"//\s*rollback-incompatible:\s*(.+)")


def up_body(source):
    """Text of the Up(MigrationBuilder) method (brace matched)."""
    m = re.search(r"void\s+Up\s*\(\s*MigrationBuilder\s+\w+\s*\)", source)
    if not m:
        return ""
    i = source.index("{", m.end())
    depth = 0
    for j in range(i, len(source)):
        depth += {"{": 1, "}": -1}.get(source[j], 0)
        if depth == 0:
            return source[i:j + 1]
    return source[i:]


def calls(body, name):
    """Argument text of every migrationBuilder.<name>(...) / <name><T>(...) call."""
    out = []
    for m in re.finditer(r"\.\s*" + name + r"\s*(<[^>]*>)?\s*\(", body):
        depth, start = 0, m.end() - 1
        for j in range(start, len(body)):
            depth += {"(": 1, ")": -1}.get(body[j], 0)
            if depth == 0:
                out.append(body[start + 1:j])
                break
    return out


def findings(source):
    body = up_body(source)
    found = []
    for name in DESTRUCTIVE_CALLS:
        for args in calls(body, name):
            target = re.search(r'name:\s*"([^"]+)"', args)
            found.append(f"{name}({target.group(1) if target else '…'})")
    for args in calls(body, "AddColumn"):
        if re.search(r"nullable:\s*false", args) and not re.search(r"defaultValue(Sql)?\s*:", args):
            col = re.search(r'name:\s*"([^"]+)"', args)
            found.append(f"AddColumn({col.group(1) if col else '…'}) is NOT NULL without a database default")
    for args in calls(body, "Sql"):
        if RAW_SQL.search(args):
            found.append(f"Sql(...) contains '{RAW_SQL.search(args).group(1)}'")
    return found


def check(directory):
    failed = False
    for fname in sorted(os.listdir(directory)):
        if not fname.endswith(".cs") or fname.endswith(".Designer.cs") or "ModelSnapshot" in fname:
            continue
        name = fname.split("_", 1)[-1][:-3]
        if name in BASELINE:
            continue
        with open(os.path.join(directory, fname), encoding="utf-8-sig") as f:
            source = f.read()
        found = findings(source)
        marker = MARKER.search(source)
        if found and marker:
            print(f"NOTE  {fname}: rollback-incompatible ({marker.group(1).strip()}): {', '.join(found)}")
        elif found:
            print(f"FAIL  {fname}: {', '.join(found)}")
            failed = True
        else:
            print(f"ok    {fname}")
    if failed:
        print("\nMake the change expand-only (add now, remove in a later release), or mark the migration with\n"
              "`// rollback-incompatible: <why>` and say in the release notes that rollback means restoring the backup.")
    return 1 if failed else 0


def self_test():
    ok_src = 'void Up(MigrationBuilder mb) { mb.AddColumn<bool>(name: "x", table: "t", nullable: false, defaultValue: false); mb.CreateIndex(name: "i", table: "t", column: "x"); }'
    assert findings(ok_src) == [], findings(ok_src)
    bad = ('void Up(MigrationBuilder mb) { mb.DropColumn(name: "old", table: "t"); '
           'mb.AddColumn<int>(name: "n", table: "t", nullable: false); mb.Sql("ALTER TABLE t DROP COLUMN y;"); }'
           ' void Down(MigrationBuilder mb) { mb.DropTable(name: "ignored"); }')
    f = findings(bad)
    assert f == ["DropColumn(old)", "AddColumn(n) is NOT NULL without a database default", "Sql(...) contains 'DROP COLUMN'"], f
    assert findings('void Up(MigrationBuilder mb) { mb.AddColumn<int>(name: "n", table: "t", nullable: true); }') == []
    assert MARKER.search("// rollback-incompatible: drops the legacy table").group(1) == "drops the legacy table"
    print("self-test ok")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    sys.exit(check(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DIR))
