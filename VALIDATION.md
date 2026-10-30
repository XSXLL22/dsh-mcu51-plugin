# Validation scope / 验证范围

This is an experimental Windows x64 release, not a claim of compatibility with
every device in the offline catalog. Transport ACKs, cold-start state and user
reports are different evidence; an ACK is not an independent Flash readback.

| Scope | Evidence through 2026-10-29 | Boundary |
|---|---|---|
| CT107D / IAP15F2K61S2 / F449 / BSL 7.2.5S | Original 4029-byte gs12, 32 programming blocks, finish and options ACKs; independent cold-start status; user reports normal display/keys | One board and BSL, 12MHz requested IRC; no independent host Flash readback |
| Public mcu_flash with expectedUid | Default bundled transport accepted, matching erase ACK UID, timeouts restored, process closed and lock released | UID arrives after erase; cannot prevent erasing the wrong target |
| Hardware options | Watchdog prescaler 256→128→256, each followed by independent cold-start status; final 16 decoded fields restored | Other changes tested offline; watchdog timing itself not measured |
| Shared IAP case | Combined diagnostic image/data, F000H–F1FFH 512 bytes matched after cold start using firmware-assisted MOVC/UART; original code restored | Not host ISP readback, not a generic EEPROM backup; preservation/erase extent unknown |
| Serial assistant | Basic 2400-baud telemetry previously observed; line fragmentation replay and parameter/cancel/lock tests | Most new framing/flow control configurations use simulated transport |
| Catalog | 719 official software table records; datasheet address layouts for 18 models | Catalog membership is not download support or hardware validation |
| Erase receiver | Strict framing/UID/budgets/cleanup in simulated faults; normal ACK on actual F449 | Real failure recovery and the old intermittent 00 root cause remain unproved |

The 2026-10-29 normal-ACK hardware run recorded a 0.231ms host callback gap
between 05 ACK and 03 request, with no intervening serial reconfiguration.
No 10ms delay was added. This is one host observation, not an electrical trace
or a causal test of whether a delay is needed under other conditions.

Historical source milestones: MCU-019 (options), MCU-029 (fixed shared-IAP
diagnostic), MCU-035 (development receiver), MCU-037 (product integration),
MCU-038 / e958dd18fbaec2ef1e94a43a570bd9537dc57922 (public product path).
Raw personal development logs and firmware are kept in the private research
repository; they are not required to install or use the plugin.

Release-specific SDK, archive and test results are published with each release.
An isolated real-SDK entry check does not establish that an already-running
Desktop process has loaded a newly installed generation.
