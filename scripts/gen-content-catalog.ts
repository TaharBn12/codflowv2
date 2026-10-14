#!/usr/bin/env python3
"""Generate cod-client-astro/src/features/settings/content-catalog.ts from the
theme01 language packs (ar.ts/en.ts) so defaults can never drift from the theme.

Run:
  node scripts/gen-content-catalog.mjs > /tmp/catalog-dump.json.txt
  python3 scripts/gen-content-catalog.ts
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DUMP = Path("/tmp/catalog-dump.json.txt")
OUT = ROOT / "cod-client-astro/src/features/settings/content-catalog.ts"

txt = DUMP.read_text()
parts = txt.split("=== ")
sections_part = [p for p in parts if p.startswith("SECTIONS")][0]
ar_part = [p for p in parts if p.startswith("AR DEFAULTS")][0]
en_part = [p for p in parts if p.startswith("EN DEFAULTS")][0]
sections = json.loads(sections_part[sections_part.index("["):sections_part.rindex("]") + 1])
ar = json.loads(ar_part[ar_part.index("{"):ar_part.rindex("}") + 1])
en = json.loads(en_part[en_part.index("{"):en_part.rindex("}") + 1])
assert list(ar) == list(en), "ar/en key order mismatch"
keys = list(ar)
assert sum(len(s["keys"]) for s in sections) == len(keys)

def slug(t):
    return re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")

def ts_str(s):
    return s.replace("\\", "\\\\").replace('"', '\\"')

out = []
out.append("/**")
out.append(" * GENERATED FILE — do not edit by hand.")
out.append(" *")
out.append(" * Key order and default strings come from cod-astro/theme01/src/theme/content/")
out.append(" * {ar,en}.ts. Regenerate with scripts/gen-content-catalog.{mjs,ts}. The")
out.append(" * content-catalog.test.ts test fails if this file drifts from the theme packs.")
out.append(" * Field/section labels live in content-labels.ts (hand-written).")
out.append(" */")
out.append('export type StoreContentLang = "ar" | "en";')
out.append('export type ContentLocale = "ar" | "en" | "fr";')
out.append("")
out.append("export interface ContentSection {")
out.append("  id: string;")
out.append("  keys: string[];")
out.append("}")
out.append("")
out.append('export const CONTENT_LANGS: StoreContentLang[] = ["ar", "en"];')
out.append("")
out.append("// Key order matches the theme packs (and the StoreFrontContent interface).")
out.append("export const CONTENT_SECTIONS: ContentSection[] = [")
for s in sections:
    out.append(f'  {{ id: "{slug(s["title"])}", keys: [')
    for k in s["keys"]:
        out.append(f'    "{k}",')
    out.append("  ] },")
out.append("];")
out.append("")
out.append("// Default strings from the theme01 Arabic / English packs.")
out.append("export const CONTENT_DEFAULTS: Record<StoreContentLang, Record<string, string>> = {")
out.append("  ar: {")
for k, v in ar.items():
    out.append(f'    "{k}": "{ts_str(v)}",')
out.append("  },")
out.append("  en: {")
for k, v in en.items():
    out.append(f'    "{k}": "{ts_str(v)}",')
out.append("  },")
out.append("};")
out.append("")

OUT.write_text("\n".join(out))
print(f"wrote {OUT} — {len(keys)} keys, {len(sections)} sections")
