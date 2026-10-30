# Bundled third-party software

This Windows x64 plugin includes its own isolated Python runtime. Installing or
using system Python, pip, STC-ISP, PZ-ISP, sscom or the original helper programs
is not required. Upstream libraries are redistributed, not reimplemented or
claimed as original work. Their source files and notices remain in the package.

| Component | Version | Source and license location |
|---|---|---|
| CPython | 3.14.7 | https://www.python.org/ — `runtime/win32-x64/LICENSE.txt` (PSF and included runtime notices) |
| pyserial | 3.5 | https://github.com/pyserial/pyserial — `licenses/pyserial-3.5-LICENSE.txt` (BSD-3-Clause) |
| stcgal | 1.10 | https://github.com/grigorig/stcgal — `licenses/stcgal-1.10-MIT.txt` and source file headers (MIT) |
| Pillow | 12.3.0 | https://github.com/python-pillow/Pillow — `runtime/win32-x64/Lib/site-packages/pillow-12.3.0.dist-info/licenses/LICENSE` (MIT-CMU and bundled library notices) |
| tqdm | 4.70.1 | https://github.com/tqdm/tqdm — `runtime/win32-x64/Lib/site-packages/tqdm-4.70.1.dist-info/licenses/LICENCE` |
| colorama | 0.4.6 | https://github.com/tartley/colorama — `runtime/win32-x64/Lib/site-packages/colorama-0.4.6.dist-info/licenses/LICENSE.txt` (BSD) |
| stc8prog protocol reference | STC15B fields from upstream main | https://github.com/IOsetting/stc8prog — `licenses/stc8prog-Apache-2.0.txt` (Apache-2.0) |

The STC15B factory-clock handshake in `sidecar/isp.py` is a Python adaptation
of the documented packet fields/formulas in IOsetting's `src/stc8db.c`,
`src/stc8prog.c` and `src/stc8prog.h`. Copyright 2021-2022 IOsetting
<iosetting@outlook.com>. The adaptation adds bounded responses, explicit
acknowledgement checks, expected-frequency checks and structured reporting.

The IAP15F2K61S2/BSL7.2.5S calibration profile in `sidecar/isp.py` adapts
the MIT stcgal range/trim algorithm, retaining the above license notice. Its
11-candidate coarse request, 0x92 pulses and integer interpolation were checked
against a local STC-ISP6.75 UART transaction and x86 analysis. The vendor EXE,
GUI and disassembly are not included or required by the released plugin.

`data/official-stc15.json` contains model-bound voltage/option facts reconstructed
from the same official STC-ISP6.75 binary (its SHA256 and data addresses are
recorded inside). These are nominal software display values, not measurements.
The plugin retains upstream `uart2_*` option keys for compatibility and labels
their verified TXD/RXD meaning. No vendor executable or resource library is required.
`data/chip-catalog.json` records names, primary/alternate model identifiers and
addresses from that same table, preserving ambiguous matches and provenance.
Its presence does not imply flash capacity, protocol support or hardware validation.

`data/storage-catalog.json` adds numeric code/EEPROM table fields and programmer
file-address bases extracted from the pinned STC-ISP6.75 table, with instruction
addresses and the executable SHA256 in reconstruction evidence. Eighteen S2 model
layouts are checked against STC's 2015-10-10 STC15 datasheet, PDF page 633:
https://www.stcmicro.com/datasheet/STC15F2K60S2-en.pdf#page=633 .
Only bounded technical facts are bundled; neither the vendor executable nor the
manual or UI resources are redistributed. These offline facts do not establish
connected BSL limits, ISP readback, erase preservation or hardware validation.

`data/stc15-memory-protocol.json` contains bounded command-layout facts from
the same pinned official binary, reconstructed using 29 checked instruction
fingerprints. It is used only for offline previews. No vendor executable/code
module is bundled; no EEPROM transfer or preservation claim is inferred.

Pillow contains FreeType and image codec libraries; their complete notices are
included in the Pillow license file. Portions of this software are copyright
© The FreeType Project (https://freetype.org). All rights reserved. This software
is based in part on the work of the Independent JPEG Group.

The reduced CPython DLL set omits OpenSSL, Tcl/Tk and CPython test extensions.
SHA256 uses CPython's built-in implementation. Microsoft runtime restrictions
and the libffi notice are included in the CPython license file. This package is
for Windows only. No Keil compiler, proprietary ISP executables or Microsoft
font files are redistributed. Text glyphs use fonts already installed by Windows
or an explicit font file selected by the user; image conversion needs no font.

`scripts/bundle_runtime.py` is a maintainer build step using an existing licensed
CPython installation with pinned package versions. It copies only the named
packages, metadata, standard library and required native runtime files. It never
copies user settings or site customization. `runtime/win32-x64/manifest.json`
records every included runtime file's SHA256; `scripts/package_release.py`
checks those hashes before creating an offline release.
