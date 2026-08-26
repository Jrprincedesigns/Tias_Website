"""Check every richtext setting value against Shopify's rule:
top-level nodes must be <p>, <ul>, <ol> or <h1>-<h6>."""
import json, re, glob, sys

OK = ('<p', '<ul', '<ol', '<h1', '<h2', '<h3', '<h4', '<h5', '<h6')

def load_json(path):
    s = open(path, encoding='utf-8').read()
    s = re.sub(r'^/\*.*?\*/\s*', '', s, flags=re.S)   # Shopify auto-gen header
    return json.loads(s)

def schema_of(section_type):
    path = f'sections/{section_type}.liquid'
    try:
        s = open(path, encoding='utf-8').read()
    except FileNotFoundError:
        return None
    m = re.search(r'\{%\s*schema\s*%\}(.*?)\{%\s*endschema\s*%\}', s, re.S)
    return json.loads(m.group(1)) if m else None

def richtext_ids(schema):
    """ids of richtext settings, at section level and per block type"""
    section = {s['id'] for s in schema.get('settings', []) if s.get('type') == 'richtext' and 'id' in s}
    blocks = {}
    for b in schema.get('blocks', []):
        blocks[b['type']] = {s['id'] for s in b.get('settings', []) if s.get('type') == 'richtext' and 'id' in s}
    return section, blocks

problems = []

# 1. presets declared inside section files
for f in sorted(glob.glob('sections/*.liquid')):
    stype = f.split('/')[-1].replace('.liquid', '')
    schema = schema_of(stype)
    if not schema:
        continue
    sec_rt, blk_rt = richtext_ids(schema)
    for preset in schema.get('presets', []):
        for key, val in (preset.get('settings') or {}).items():
            if key in sec_rt and isinstance(val, str) and not val.startswith('t:') and not val.strip().startswith(OK):
                problems.append((f, f"preset '{preset.get('name')}' setting '{key}'", val))
        for blk in preset.get('blocks', []) or []:
            ids = blk_rt.get(blk.get('type'), set())
            for key, val in (blk.get('settings') or {}).items():
                if key in ids and isinstance(val, str) and not val.startswith('t:') and not val.strip().startswith(OK):
                    problems.append((f, f"preset '{preset.get('name')}' block '{blk['type']}' setting '{key}'", val))
        # also check defaults declared on the settings themselves
    for s in schema.get('settings', []):
        if s.get('type') == 'richtext' and isinstance(s.get('default'), str) and not s['default'].startswith('t:') and not s['default'].strip().startswith(OK):
            problems.append((f, f"default for setting '{s.get('id')}'", s['default']))
    for b in schema.get('blocks', []):
        for s in b.get('settings', []):
            if s.get('type') == 'richtext' and isinstance(s.get('default'), str) and not s['default'].startswith('t:') and not s['default'].strip().startswith(OK):
                problems.append((f, f"default for block '{b['type']}' setting '{s.get('id')}'", s['default']))

# 2. template JSON files
for f in sorted(glob.glob('templates/*.json')) + sorted(glob.glob('sections/*.json')):
    try:
        d = load_json(f)
    except Exception:
        continue
    for name, sec in (d.get('sections') or {}).items():
        schema = schema_of(sec.get('type', ''))
        if not schema:
            continue
        sec_rt, blk_rt = richtext_ids(schema)
        for key, val in (sec.get('settings') or {}).items():
            if key in sec_rt and isinstance(val, str) and val.strip() and not val.startswith('t:') and not val.strip().startswith(OK):
                problems.append((f, f"{name}.{key}", val))
        for bid, blk in (sec.get('blocks') or {}).items():
            ids = blk_rt.get(blk.get('type'), set())
            for key, val in (blk.get('settings') or {}).items():
                if key in ids and isinstance(val, str) and val.strip() and not val.startswith('t:') and not val.strip().startswith(OK):
                    problems.append((f, f"{name}.{bid}.{key}", val))

for f, where, val in problems:
    print(f"{f}\n    {where}\n    {val[:70]!r}\n")
print(f"{len(problems)} richtext value(s) that Shopify will reject")
sys.exit(1 if problems else 0)
