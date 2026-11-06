# Bundled fonts and their licences

The hub image installs these faces from Debian 12 (bookworm) packages (`Dockerfile`), and `bundled.ts`
registers them as library fonts with `source: 'bundled'` (design/27 §10). The hub serves them to every
output, and LibreOffice draws art and picture slides with the same files. No font file is kept in this
repository.

Every face is licensed under the SIL Open Font License, Version 1.1. The licence text is in
[OFL-1.1.txt](OFL-1.1.txt), and the image keeps each package's copyright file under
`/usr/share/doc/<package>/copyright`.

| Family                                                                                                        | Faces                                    | Package (bookworm)                 | Copyright                                                                       | Reserved Font Names               |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- | --------------------------------- |
| Inter                                                                                                         | Regular, Italic, Bold, Bold Italic (OTF) | fonts-inter 4.0~beta7+ds-1         | 2016-2022 The Inter Project Authors (https://github.com/rsms/inter)             | none                              |
| Carlito                                                                                                       | Regular, Italic, Bold, Bold Italic       | fonts-crosextra-carlito 20220224-1 | (c) 2010-2013 by tyPoland Lukasz Dziedzic                                       | Carlito                           |
| Caladea                                                                                                       | Regular, Italic, Bold, Bold Italic       | fonts-crosextra-caladea 20200211-2 | 2012 The Caladea Project Authors (https://github.com/huertatipografica/Caladea) | none                              |
| Liberation Sans, Liberation Serif, Liberation Mono                                                            | Regular, Italic, Bold, Bold Italic       | fonts-liberation2 2.1.5-1          | Digitized data (c) 2010 Google Corporation; (c) 2012 Red Hat, Inc.              | Arimo, Tinos, Cousine; Liberation |
| Noto Sans                                                                                                     | Regular, Italic, Bold, Bold Italic       | fonts-noto-core 20201225-1         | 2010, 2012-2020 Google Inc.; 2015-2020 Google LLC                               | none                              |
| Noto Sans Hebrew, Noto Naskh Arabic, Noto Sans Devanagari, Noto Sans Tamil, Noto Sans Thai, Noto Sans Myanmar | Regular, Bold                            | fonts-noto-core 20201225-1         | 2010, 2012-2020 Google Inc.; 2015-2020 Google LLC                               | none                              |

The faces are served unmodified, under the families above (their own names). Where a face stands in for
another family (Carlito for Calibri, Caladea for Cambria, Liberation for Arial, Times New Roman and Courier
New), only ordo's font stack refers to the other name; the face is never renamed.

Not bundled:
- Liberation Sans Narrow: only Liberation 1.x has it, under the GPL with a font exception.
- URW base35 (AGPL with a font exception) and Wine's fonts (LGPL).
- Gelasio and the Noto CJK families: added on demand through Google Fonts (`font-google` job), also OFL.

To add a face: install it in the `Dockerfile`, list it in `BUNDLED_FACES` (`bundled.ts`) and in the table
above, and check that its licence allows redistribution with software (OFL or Apache-2.0).
