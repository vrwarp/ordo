# WordArt text warps (ECMA-376 presetTextWarpDefinitions)

`presetTextWarpDefinitions.xml` holds the 40 preset text warps of ECMA-376 Part 1 (`a:prstTxWarp prst`:
`textPlain`, `textArchUp`, `textWave1`, ... the shapes PowerPoint bends WordArt text to), each as adjust values,
guide formulas, paths and adjust handles. ordo compiles it with `tools/geom-gen` into
`packages/renderer/src/geom/textwarps.gen.ts` (r2b sub-wave 2, warp-geom); the code that builds a warp at a box is
`packages/renderer/src/geom/textwarp.ts`. The file has no text rectangle (the text takes the whole box), no
connection sites and no fixes.

| File                                | From                                                                                                                                                                                                                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presetTextWarpDefinitions.xml`     | docx4j-core 11.4.11 (`org.docx4j:docx4j-core:11.4.11`), jar entry `org/docx4j/model/shapes/presetTextWarpDefinitions.xml`: 61,386 bytes, SHA-256 `665b2e494d853d1e776d5b59322926a089ba7933236a9458e49389545c621fd1` (`tools/geom-gen` checks it). The jar's SHA-1 is `eeec8c1af4470cae43edfa24a3570293465405ad`, equal to the `.sha1` file Maven stored beside it. |
| `LICENSE`                           | The standard Apache License 2.0 text (Debian's `/usr/share/common-licenses/Apache-2.0`: 11,358 bytes, SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`), equal to the Apache 2.0 body that `third_party/poi-presets/LICENSE` carries up to its `END OF TERMS AND CONDITIONS` line. It is not a copy of that file, which appends third-party licences that do not apply here. |

## Where it comes from, and why it is the ECMA-376 file

- **Licence.** The jar's manifest says `Bundle-License: http://www.apache.org/licenses/LICENSE-2.0.txt` and its
  pom lists `<license><name>Apache 2</name>`. The jar ships no `LICENSE` or `NOTICE` file (`META-INF` holds
  `MANIFEST.MF`, the pom and `pom.properties` only), so none is vendored: Apache-2.0 section 4(d) asks for a
  `NOTICE` only when the Work has one.
- **Content.** The file is canonically equal to ECMA-376's own annex entry `presetTextWarpDefinitions.xml` (51,599
  bytes, SHA-256 `89640bd4aeedfa2c578d1d1acc50d569865ebdef315fd4b468087c25e36acada`, an entry of
  `OfficeOpenXML-DrawingMLGeometries.zip`, whose SHA-256 the M9 warps design records as
  `a8517838a3a60492d267d1ff92e1ebd831adc04584de79a38a5532a68902abf6`): the same elements, attributes, order
  and text, 40 presets; only the whitespace differs. Checked with `python3 -I` (zipfile and ElementTree, nothing
  executed). When this was recorded the annex zip itself was no longer on the machine, so the comparison read
  the entry extracted from it earlier (same size and SHA-256 as above); the zip's own SHA-256 is quoted from the
  design and was not recomputed.
- **Unchanged.** The file here is the jar's entry byte for byte and no fix is applied: `tools/geom-gen` reads it as
  it is and refuses any element or attribute its compiler would not read.

The compiled form (op codes, slots, bounds) and what the generator requires of the file are described in
`tools/geom-gen/README.md`.
