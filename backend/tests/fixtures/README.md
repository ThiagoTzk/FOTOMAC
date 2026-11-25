# Test photos

Deliberately NOT photos of CESMAC events: the test suite must not carry personal data of event
participants (LGPD Art. 6, III). Both are public-domain works of NASA (U.S. federal government).

| File | What | Source |
|---|---|---|
| `apollo11_crew.jpg` | Apollo 11 prime crew portrait, 3 faces (S69-31740, May 1969) | https://images.nasa.gov/details/S69-31740 (medium size) |
| `astronaut_eileen_collins.png` | Astronaut Eileen Collins, 1 face — the "stranger" of the search tests | NASA, distributed with scikit-image as `skimage.data.astronaut` |

## `formats/` — samples of the other photo formats (requirements v2.0, RF007)

`sample.heic`, `sample.png`, `sample.webp` and `sample.dng`: synthetic images made for the tests
(colour blocks — red on the left, blue on the right, a grey band at the bottom; the PNG has a
transparent corner). **No person appears in them.** Each carries a FAKE GPS position (−9.6658,
−35.7353) and the capture date 2026-10-15 19:30, so the tests can prove that the location is
removed and the date kept. Made on 21/10/2026: PNG/WebP with OpenCV, HEIC with macOS `sips`, DNG
with `pidng` (outside the project), GPS written with ExifTool.

`camera-com-previa.nef`: NOT a real RAW — a TIFF header, a 640×480 JPEG preview (with a 160×120
thumbnail inside its EXIF, as cameras do) and some junk, including a false JPEG start. It proves that
the upload screen extracts the camera preview of a RAW as its thumbnail, whole (22/10/2026).

## `apple_writer.mov`: a video written by Apple software (RF034)

Synthetic (colour test pattern, 2 s, no person, no sound of anyone), written on 02/11/2026 with
AVFoundation, the same code an iPhone uses: "qt" brand, HEVC, a `mebx` track with a FAKE location
(−9.6498, −35.7089), Apple's metadata keys ("iPhone 15") and a rotation. It proves that the location
is removed from a real Apple file and that the rotation survives.
