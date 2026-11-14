#!/usr/bin/env python3
"""
Corpus downloader and analyzer for golden PPTX test suite.

    python3 -I tools/download_golden_pptx.py            download what corpus_manifest_input.json lists, then
                                                         rewrite golden-pptx/manifest.json and README.md
    python3 -I tools/download_golden_pptx.py --readme   no download: refresh the generated decks' entries
                                                         from their files and rewrite manifest.json and README.md

A deck written by a generator in this repository (an entry with "generator", the generator's path from the
repository root, instead of "source_url") is never downloaded: a rewrite keeps its entry, after the
downloaded ones, with its slide count, features and size read again from its file
(golden-pptx/challenging-features/custom-geometry/line-art-holes.pptx, tools/pptx-fidelity/src/gen/).
"""

import os
import sys
import json
import urllib.request
import urllib.parse
import zipfile
import io
import re
import time

WORKSPACE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
GOLDEN_DIR = os.path.join(WORKSPACE_ROOT, "golden-pptx")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

def analyze_pptx(file_bytes):
    zf = zipfile.ZipFile(io.BytesIO(file_bytes))
    namelist = zf.namelist()

    if "ppt/presentation.xml" not in namelist:
        raise ValueError("Invalid PPTX: missing ppt/presentation.xml")

    slide_count = 0
    master_count = 0
    has_video = False
    has_audio = False
    has_smartart = False
    has_chart = False
    has_table = False
    has_3d = False
    has_math = False
    has_ink = False
    has_animation = False
    has_transition = False
    has_gradient = False
    has_shadow = False
    has_custom_geom = False
    has_rtl = False
    has_embedded_font = False

    for name in namelist:
        if name.startswith("ppt/slides/slide") and name.endswith(".xml"):
            slide_count += 1
        elif name.startswith("ppt/slideMasters/slideMaster") and name.endswith(".xml"):
            master_count += 1
        elif "ppt/diagrams/" in name:
            has_smartart = True
        elif "ppt/charts/" in name:
            has_chart = True
        elif "ppt/fonts/" in name:
            has_embedded_font = True
        elif "ppt/ink/" in name:
            has_ink = True
        elif name.startswith("ppt/media/"):
            ext = os.path.splitext(name)[1].lower()
            if ext in [".mp4", ".mov", ".wmv", ".avi", ".mkv", ".webm", ".m4v"]:
                has_video = True
            elif ext in [".mp3", ".wav", ".m4a", ".aac", ".wma", ".ogg"]:
                has_audio = True

    for name in namelist:
        if (name.startswith("ppt/slides/slide") or name == "ppt/presentation.xml") and name.endswith(".xml"):
            try:
                xml_data = zf.read(name).decode("utf-8", errors="ignore")
                if "<a:tbl" in xml_data:
                    has_table = True
                if "<a:sp3d" in xml_data or "<a:scene3d" in xml_data or "prstMaterial=" in xml_data:
                    has_3d = True
                if "<m:oMath" in xml_data:
                    has_math = True
                if "<p:timing" in xml_data or "<p:anim" in xml_data:
                    has_animation = True
                if "<p:transition" in xml_data:
                    has_transition = True
                if "<a:gradFill" in xml_data:
                    has_gradient = True
                if "<a:outerShdw" in xml_data or "<a:innerShdw" in xml_data:
                    has_shadow = True
                if "<a:custGeom" in xml_data:
                    has_custom_geom = True
                if 'rtl="1"' in xml_data or re.search(r'[\u0590-\u06ff]', xml_data):
                    has_rtl = True
                if "<p:ink" in xml_data:
                    has_ink = True
            except Exception:
                pass

    features = []
    if has_video: features.append("video")
    if has_audio: features.append("audio")
    if has_smartart: features.append("smartart")
    if has_chart: features.append("chart")
    if has_table: features.append("table")
    if has_3d: features.append("3d")
    if has_math: features.append("math")
    if has_ink: features.append("ink")
    if has_animation: features.append("animation")
    if has_transition: features.append("transition")
    if has_gradient: features.append("gradient")
    if has_shadow: features.append("shadow")
    if has_custom_geom: features.append("customGeom")
    if has_rtl: features.append("rtl")
    if has_embedded_font: features.append("embeddedFont")

    return {
        "slide_count": slide_count,
        "master_count": master_count,
        "features": features,
    }

def fetch_url(url, timeout=30, max_retries=4):
    import ssl
    import urllib.error
    parsed = urllib.parse.urlsplit(url)
    unquoted_path = urllib.parse.unquote(parsed.path)
    encoded_path = urllib.parse.quote(unquoted_path)
    clean_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, encoded_path, parsed.query, parsed.fragment))
    req = urllib.request.Request(clean_url, headers=HEADERS)

    for attempt in range(max_retries):
        try:
            try:
                ctx = ssl.create_default_context()
                with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                    if resp.status != 200:
                        raise RuntimeError(f"HTTP {resp.status}")
                    return resp.read()
            except ssl.SSLError:
                unverified_ctx = ssl._create_unverified_context()
                with urllib.request.urlopen(req, timeout=timeout, context=unverified_ctx) as resp:
                    if resp.status != 200:
                        raise RuntimeError(f"HTTP {resp.status}")
                    return resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < max_retries - 1:
                wait_time = 3.0 * (attempt + 1)
                time.sleep(wait_time)
                continue
            raise
        except Exception:
            if attempt < max_retries - 1:
                time.sleep(1.5)
                continue
            raise

def read_manifest():
    """The manifest as written (a list of entries), or an empty list when there is none."""
    path = os.path.join(GOLDEN_DIR, "manifest.json")
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def refresh_generated(entry):
    """A generated deck's entry with its slide count, features and size read from its file (when it exists)."""
    out = dict(entry)
    path = os.path.join(GOLDEN_DIR, entry["rel_path"])
    if os.path.exists(path):
        with open(path, "rb") as f:
            data = f.read()
        meta = analyze_pptx(data)
        out.update(slide_count=meta["slide_count"], master_count=meta["master_count"], features=meta["features"])
        out["file_size_bytes"] = len(data)
    order = ["slide_count", "master_count", "features", "file_size_bytes", "rel_path", "category", "generator", "description"]
    return {k: out[k] for k in order if k in out} | {k: v for k, v in out.items() if k not in order}

def merge_generated(results, previous):
    """`results` (the downloaded entries) followed by every generated entry of `previous` not among them."""
    have = {r["rel_path"] for r in results}
    kept = [refresh_generated(e) for e in previous if "generator" in e and e.get("rel_path") not in have]
    return list(results) + kept

def write_manifest(results):
    manifest_path = os.path.join(GOLDEN_DIR, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"Saved manifest to {manifest_path}")

def main():
    if "--readme" in sys.argv[1:]:
        # No download: the generated entries refreshed, the rest as they are.
        results = [refresh_generated(e) if "generator" in e else e for e in read_manifest()]
        write_manifest(results)
        generate_readme(results)
        return
    previous = read_manifest()
    with open(os.path.join(os.path.dirname(__file__), "corpus_manifest_input.json"), "r") as f:
        items = json.load(f)

    print(f"Total items to download: {len(items)}")
    results = []
    errors = []

    for idx, item in enumerate(items, 1):
        rel_path = item["rel_path"]
        category = item["category"]
        url = item["url"]
        desc = item["description"]
        dest = os.path.join(GOLDEN_DIR, rel_path)

        print(f"[{idx}/{len(items)}] Downloading {os.path.basename(rel_path)} ...", end=" ", flush=True)

        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            try:
                with open(dest, "rb") as f:
                    data = f.read()
                meta = analyze_pptx(data)
                meta["file_size_bytes"] = len(data)
                meta["rel_path"] = rel_path
                meta["category"] = category
                meta["source_url"] = url
                meta["description"] = desc
                results.append(meta)
                print(f"ALREADY EXISTS ({len(data)} bytes, {meta['slide_count']} slides, {', '.join(meta['features']) or 'basic'})")
                continue
            except Exception as e:
                print(f"Existing file corrupt, re-downloading... ({e})")

        try:
            data = fetch_url(url)
            meta = analyze_pptx(data)
            meta["file_size_bytes"] = len(data)
            meta["rel_path"] = rel_path
            meta["category"] = category
            meta["source_url"] = url
            meta["description"] = desc

            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as f:
                f.write(data)

            results.append(meta)
            print(f"OK ({len(data)} bytes, {meta['slide_count']} slides, {', '.join(meta['features']) or 'basic'})")
        except Exception as e:
            print(f"FAILED: {e}")
            errors.append({"item": item, "error": str(e)})

        # Polite pause
        if "lakelandhills" in url:
            time.sleep(1.2)
        else:
            time.sleep(0.05)

    print(f"\nCompleted: {len(results)} downloaded successfully, {len(errors)} errors.")

    # Save manifest.json, keeping the decks this repository generates.
    results = merge_generated(results, previous)
    write_manifest(results)

    # Generate README.md
    generate_readme(results)

def format_bytes(n):
    if n < 1024:
        return f"{n} B"
    elif n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    else:
        return f"{n / (1024 * 1024):.2f} MB"

def generate_readme(results):
    readme_path = os.path.join(GOLDEN_DIR, "README.md")

    # Group by category
    categories = {}
    for r in results:
        cat = r["category"]
        categories.setdefault(cat, []).append(r)

    total_slides = sum(r["slide_count"] for r in results)
    total_bytes = sum(r["file_size_bytes"] for r in results)

    # Feature counts
    feature_counts = {}
    for r in results:
        for f in r["features"]:
            feature_counts[f] = feature_counts.get(f, 0) + 1

    lines = [
        "# Golden PPTX Test Corpus",
        "",
        "This directory contains a diverse golden test corpus of PowerPoint (`.pptx`) presentations curated specifically for automated rendering verification, visual golden regression testing, and fidelity benchmarking of the `@ordo/pptx-render` and `@ordo/pptx-scene` engines.",
        "",
        "The corpus consists of **100+ presentations** heavily biased towards the **church and worship service environment** (sermons, hymn lyric slides, responsive liturgies, church announcements, pre-worship lessons), combined with targeted benchmark decks that exercise **challenging and obscure PowerPoint features** (embedded video, embedded audio, SmartArt diagrams, 3D shapes/rotations/bevels, 3D extruded text, charts, tables, digital ink, RTL/international typography, animations, and transitions).",
        "",
        "---",
        "",
        "## Notice & Removal Request / Contact Maintainer",
        "",
        "> [!IMPORTANT]",
        "> **Takedown & Removal Policy**  ",
        "> All presentation files in this corpus have been collected from publicly accessible online repositories, church websites, and open-source test suites for the sole purpose of non-commercial software compatibility, automated rendering testing, and golden regression testing.  ",
        ">  ",
        "> If you are a copyright owner, church administrator, or author of any slide deck hosted in this test suite and wish to have your file removed, please contact the maintainer immediately:  ",
        ">  ",
        "> - **Maintainer Contact**: `btsai` (or via repository issue / pull request)  ",
        "> - **Action**: Specify the filename (e.g., `golden-pptx/church-sermons/...pptx`) and source URL.  ",
        "> - **Commitment**: The file will be promptly and permanently removed from the repository upon request.",
        "",
        "---",
        "",
        "## Summary Statistics",
        "",
        f"- **Total Presentations**: {len(results)} files",
        f"- **Total Slides**: {total_slides} slides",
        f"- **Total Corpus Size**: {format_bytes(total_bytes)}",
        f"- **Feature Coverage**:",
    ]

    for feat, count in sorted(feature_counts.items(), key=lambda x: -x[1]):
        lines.append(f"  - `{feat}`: {count} decks")

    lines.extend([
        "",
        "---",
        "",
        "## Directory Structure",
        "",
        "- `church-sermons/`: Real Sunday sermon decks from multiple congregations and preachers, covering doctrinal studies, textual expository preaching, scripture citations, multi-level outlines, and background designs.",
        "- `church-worship-lyrics/`: Praise and worship slide decks, traditional hymns, contemporary worship songs, responsive readings, bilingual English/Chinese worship, Spanish worship services, and pinyin ruby-text annotations.",
        "- `church-announcements-ministry/`: Pre-worship announcements, church assembly templates, denominational gathering presentations, and ministry teaching decks.",
        "- `challenging-features/`: Targeted decks exercising advanced and obscure PowerPoint OpenXML features:",
        "  - Embedded MP4 video & common media properties",
        "  - Embedded MP3 audio tracks",
        "  - SmartArt 2D & 3D organizational charts, hierarchies, and animated diagrams",
        "  - 3D bevels, isometric rotations, soft edges, reflections, and full-slide shadows",
        "  - 3D extruded WordArt text and glow/bevel text formatting",
        "  - 2D & 3D charts (column, pie, area, radar, custom data labels, funnel charts)",
        "  - DrawingML tables, styled gridlines, and cell padding",
        "  - Digital Ink handwriting paths",
        "  - Complex DrawingML fills (gradient stops, pattern fills, tile blips)",
        "  - Special typography (Thai distributed, justified low, RTL Hebrew/Arabic)",
        "  - Synthetic guard decks written by a generator in this repository, never downloaded (`line-art-holes.pptx`: line art past the slide's drawing budget, `tools/pptx-fidelity/src/gen/`; regenerate with `pnpm --filter @ordo/pptx-fidelity gen:line-art-holes`)",
        "",
        "---",
        "",
        "## Complete Inventory & Provenance",
        "",
        "| File | Category | Slides | Size | Features | Source URL / Provenance | Description |",
        "|---|---|---|---|---|---|---|",
    ])

    for r in results:
        fname = os.path.basename(r["rel_path"])
        fpath = r["rel_path"]
        cat = r["category"]
        slides = r["slide_count"]
        size_str = format_bytes(r["file_size_bytes"])
        feats = ", ".join(r["features"]) if r["features"] else "standard text/shapes"
        desc = r["description"]
        if "generator" in r:
            # Written by a generator in this repository (linked from golden-pptx/), never downloaded.
            gen = r["generator"]
            source = f"generated by [`{gen.split('/')[-1]}`](../{gen})"
        else:
            url = r["source_url"]
            source = f"[{url.split('/')[-1]}]({url})"
        lines.append(f"| [`{fname}`]({fpath}) | {cat} | {slides} | {size_str} | {feats} | {source} | {desc} |")

    lines.append("")

    with open(readme_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"Generated {readme_path}")

if __name__ == "__main__":
    main()
