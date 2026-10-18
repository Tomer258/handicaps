"""Dependency / license review for what ships (docs/runbooks/dependencies.md).

Covers runtime dependencies only:
  NuGet  - Hangar.Api's restored graph (obj/project.assets.json) + licenses from the nuspecs in .cache/nuget/packages
  npm    - production packages in apps/web/package-lock.json (dev/devOptional excluded; they never reach the bundle)
  Python - pass --python to run inside an image: lists installed distributions and their license metadata

Each license is classed as permissive / weak-copyleft (fine for an unmodified dependency) / strong-copyleft (needs a
decision) / unknown (look it up by hand). Exit 1 if anything is strong-copyleft or unknown and not in REVIEWED.

Usage: python -I infra/scripts/license-report.py              (needs `dotnet restore` + `npm ci` done)
       docker run --rm -v "$PWD/infra/scripts:/s:ro" <image> python -I /s/license-report.py --python
"""

import json
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

PERMISSIVE = {"MIT", "MIT-0", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Zlib", "Unlicense", "CC0-1.0",
              "PostgreSQL", "Python-2.0", "PSF-2.0", "BlueOak-1.0.0", "MS-PL"}
WEAK_COPYLEFT = {"MPL-2.0", "LGPL-2.1", "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0", "LGPL-3.0-only", "LGPL-3.0-or-later", "EPL-2.0"}
# Free-text license fields seen in package metadata -> SPDX.
ALIASES = {"Apache License 2.0": "Apache-2.0", "Apache Software License": "Apache-2.0", "3-Clause BSD License": "BSD-3-Clause",
           "BSD License": "BSD-3-Clause", "MIT License": "MIT"}
# Hand-checked entries whose metadata doesn't carry an SPDX id: "<ecosystem>:<name>" -> license.
REVIEWED = {
    "nuget:Microsoft.*": "MIT",  # .NET packages without a license element point to the MIT dotnet license URL
}
URL_LICENSES = [  # licenseUrl -> SPDX for older nuspecs
    (r"licenses\.nuget\.org/([\w.\-+]+)", None),
    (r"opensource\.org/licenses/MIT|/MIT(\.txt)?$|LICENSE\.TXT$", "MIT"),
    (r"apache\.org/licenses/LICENSE-2\.0", "Apache-2.0"),
]


def classify(expr):
    expr = ALIASES.get(expr, expr)
    if not expr:
        return "unknown"
    parts = [p.strip("() ") for p in re.split(r"\s+(?:OR|AND)\s+", expr)]
    if " OR " in expr and any(p in PERMISSIVE for p in parts):
        return "permissive"  # dual-licensed: we take the permissive option
    if all(p in PERMISSIVE for p in parts):
        return "permissive"
    if all(p in PERMISSIVE | WEAK_COPYLEFT for p in parts):
        return "weak-copyleft"
    if any(re.match(r"A?GPL|SSPL|EUPL|OSL|CC-BY-SA", p) for p in parts):
        return "strong-copyleft"
    return "unknown"


def reviewed(eco, name):
    for key, lic in REVIEWED.items():
        k_eco, k_name = key.split(":", 1)
        if k_eco == eco and (k_name == name or (k_name.endswith("*") and name.startswith(k_name[:-1]))):
            return lic
    return None


def nuget():
    assets = json.load(open(os.path.join(ROOT, "apps/api/src/Hangar.Api/obj/project.assets.json"), encoding="utf-8"))
    out = []
    for key, lib in assets["libraries"].items():
        if lib.get("type") != "package":
            continue
        name, version = key.split("/")
        nuspec = os.path.join(ROOT, ".cache/nuget/packages", name.lower(), version.lower(), f"{name.lower()}.nuspec")
        lic = None
        if os.path.exists(nuspec):
            text = open(nuspec, encoding="utf-8-sig").read()
            m = re.search(r'<license type="expression">([^<]+)</license>', text)
            if m:
                lic = m.group(1)
            else:
                url = re.search(r"<licenseUrl>([^<]+)</licenseUrl>", text)
                for pattern, spdx in URL_LICENSES if url else []:
                    hit = re.search(pattern, url.group(1))
                    if hit:
                        lic = spdx or hit.group(1)
                        break
        out.append(("nuget", name, version, lic or reviewed("nuget", name)))
    return out


def npm():
    lock = json.load(open(os.path.join(ROOT, "apps/web/package-lock.json"), encoding="utf-8"))
    out = []
    for path, pkg in lock["packages"].items():
        if not path or pkg.get("dev") or pkg.get("devOptional"):
            continue
        name = path.split("node_modules/")[-1]
        lic = pkg.get("license")
        out.append(("npm", name, pkg.get("version", "?"), lic if isinstance(lic, str) else reviewed("npm", name)))
    return out


def python():
    from importlib import metadata
    out = []
    for dist in metadata.distributions():
        md = dist.metadata
        lic = md.get("License-Expression")
        if not lic:
            classifiers = [c.split(" :: ")[-1] for c in md.get_all("Classifier") or [] if c.startswith("License ::")]
            lic = {"MIT License": "MIT", "Apache Software License": "Apache-2.0", "BSD License": "BSD-3-Clause",
                   "ISC License (ISCL)": "ISC", "Python Software Foundation License": "PSF-2.0"}.get(classifiers[0]) if classifiers else None
        if not lic and md.get("License") and len(md.get("License")) < 40:
            lic = md.get("License")
        name = md["Name"]
        if name in ("pip", "setuptools", "wheel"):
            continue  # image tooling, not an application dependency
        out.append(("python", name, md["Version"], lic or reviewed("python", name)))
    return out


def report(rows):
    bad = []
    by_class = {}
    for eco, name, version, lic in sorted(rows):
        cls = classify(lic)
        by_class.setdefault(cls, []).append(f"{eco}:{name}@{version} ({lic or '?'})")
        if cls in ("strong-copyleft", "unknown"):
            bad.append(f"{eco}:{name}@{version} ({lic or '?'})")
    for cls in ("permissive", "weak-copyleft", "strong-copyleft", "unknown"):
        items = by_class.get(cls, [])
        print(f"{cls}: {len(items)}")
        if cls != "permissive":
            for i in items:
                print(f"  {i}")
    licenses = sorted({(lic or "?") for *_, lic in rows})
    print("licenses seen:", ", ".join(licenses))
    if bad:
        print("\nNeeds a decision: add it to REVIEWED with the checked license, or replace the dependency.")
    return 1 if bad else 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        assert classify("MIT") == "permissive" and classify("(MIT OR GPL-3.0)") == "permissive"
        assert classify("MPL-2.0") == "weak-copyleft" and classify("Apache-2.0 AND LGPL-2.1") == "weak-copyleft"
        assert classify("AGPL-3.0") == "strong-copyleft" and classify(None) == "unknown" and classify("Custom") == "unknown"
        assert classify("Apache License 2.0") == "permissive"
        assert reviewed("nuget", "Microsoft.Extensions.Logging") == "MIT" and reviewed("npm", "x") is None
        print("self-test ok")
        sys.exit(0)
    sys.exit(report(python() if "--python" in sys.argv else nuget() + npm()))
