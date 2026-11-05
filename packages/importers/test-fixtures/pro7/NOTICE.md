# ProPresenter 7 test files

Real ProPresenter 7 files, used by `src/pro7.real.test.ts` so the importer is checked against what
ProPresenter writes rather than against documents we encode ourselves. They are copied unchanged.

| File                             | From                                                                                                                    | What it shows                                                                                                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RestBildExportFromPP.probundle` | [bussnet/propresenter7-php-lib](https://github.com/bussnet/propresenter7-php-lib), `doc/reference_samples/`             | A bundle exported by ProPresenter itself: a one-slide song with a background picture at `Media/`. The media action carries an empty `audio` playback block, which once made ordo drop the picture.  |
| `TestPlaylist.proplaylist`       | same                                                                                                                    | A playlist export with two embedded songs, a header, a placeholder and `arrangement_name` on its items.                                                                                             |
| `Café Über Test.pro`             | same, `doc/reference_samples/all-songs/`                                                                                | RTF with `\'hh` umlauts on one line and raw UTF-8 bytes on the next.                                                                                                                                |
| `Rock Of Ages (Toplady).pro`     | [greyshirtguy/Pro7ChordEditor](https://github.com/greyshirtguy/Pro7ChordEditor), `testdata/files/made-by-propresenter/` | Written by ProPresenter 7.9 on a Mac, byte for byte: ALL CAPS, a text outline, a gradient box fill, cues stored out of group order, a visibility link on every box. The words are Toplady's (1776). |

Both repositories are under the MIT licence:

- Copyright (c) 2026 Thorsten Buss (propresenter7-php-lib)
- Copyright (c) 2023-2026 greyshirtguy (Pro7ChordEditor)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions: The above copyright notice and this
permission notice shall be included in all copies or substantial portions of the Software. THE
SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.

ProPresenter is a trademark of Renewed Vision. Neither project nor ordo is affiliated with them.
No file here holds a copyrighted song: the sample texts are invented or out of copyright.
