# dsh-mcu51 0.3.0-alpha.3

Windows x64 的 DSH 51 单片机工具箱，提供 12 个聊天工具：内置 STC UART ISP、串口调试、
硬件选项、镜像缓冲区、芯片资料、计算器、字模和简谱转换，以及可选的 Keil 工程编译。

A standalone Windows x64 DSH bundle with 12 tools for 8051 development. The release
includes an isolated Python runtime; it does not require STC-ISP, PZ-ISP or system Python.

这是实验测试版。CT107D / IAP15F2K61S2 / BSL 7.2.5S 已完成原 gs12 烧录、冷启动状态和用户按键验收。
719 条芯片目录是离线资料，不能当成 719 种芯片均可烧录。具体证据和限制见 [VALIDATION.md](VALIDATION.md)。

## 安装

需要 Windows x64、DSH 0.2.1-rc.2 / 0.2.1 系列兼容宿主，以及已被 Windows 识别的串口驱动。
官方 Cordis 和 dsh-tools 由宿主提供；本版未声明支持后续尚未验证的 0.2.2 系列。

从 [v0.3.0-alpha.3 Release](https://github.com/XSXLL22/dsh-mcu51-plugin/releases/tag/v0.3.0-alpha.3)
下载完整 `.tgz` 或 `.zip`。使用 DSH 插件管理安装 `.tgz` 或 ZIP 解压后的插件根目录。
使用命令行管理的 DSH 可执行：

```powershell
dsh plugin --profile <你的配置名> add https://github.com/XSXLL22/dsh-mcu51-plugin/releases/download/v0.3.0-alpha.3/dsh-mcu51-0.3.0-alpha.3-win32-x64.tgz
```

Desktop 请通过应用自己的插件管理器安装，避免误装到另一个 web profile。
如宿主提示需要重启，按其正常流程重启，再检查版本、12 个工具及 `mcu_doctor` 的结果。
安装成功提示本身不能证明当前进程已加载新代码；不要手改 generation 或 app.asar。

**请安装完整 Release 包。源码仓库不保存运行时二进制，GitHub 自动生成的 Source code ZIP 不能直接使用。**
插件执行不依赖开发工作区、官方 ISP、系统 Python 或网络下载脚本；没有安装期自动烧录操作。

## 工具与范围

| 工具 | 功能 | 已验证范围 |
|---|---|---|
| `mcu_doctor` | 随包运行时、完整性、串口、板档案和可选 Keil 体检 | 枚举/隔离运行/哈希检查；体检通过不等于烧录通过 |
| `mcu_build` | 已有 Keil C51 工程编译和 HEX 解析 | 使用用户安装并授权的 Keil；不分发编译器 |
| `mcu_flash` | HEX、冻结代码镜像或受约束 memoryApplication 烧录 | F449/7.2.5S 原 gs12 公开工具路径实机通过；其它型号不作同等承诺 |
| `mcu_chipinfo` | 型号、BSL、频率、原始 MSR 和结构化硬件选项 | F449 实机 16 字段查询；读取不校准或擦写 |
| `mcu_options` | schema/read/plan/prepare/apply | 15 字段离线计划；分频 256→128→256 冷启动持久化实测 |
| `mcu_catalog` | 719 条官方型号记录、主/备用 magic、容量事实 | 18 型号有手册地址布局，其余未知；不会新增下载协议支持 |
| `mcu_image` | HEX/BIN 双逻辑缓冲、偏移合并、导出、擦写预览和 prepare | 离线镜像；F449 固定组合案例已实测，数据保留未知 |
| `mcu_serial` | 文本/HEX、时间戳、编码、串口帧/流控、预算、取消和 dryRun | 基本遥测实测；新帧配置主要封闭模拟 |
| `mcu_calc` | 波特率、定时器、延时、DAC、超声波计算 | 离线；必须选对主频、Timer 和 1T/12T 模式 |
| `mcu_glyph` | 文本/图片取模、扫描/位序、C 数组和 PNG | 文本使用已安装字体或用户指定字体，不分发 Microsoft 字体 |
| `mcu_tone` | 简谱转频率、时长、C 数组 | 离线转换 |
| `mcu_project` | 本机工程登记与查询 | 存储在用户数据目录 |

## 开始使用

1. 调用 `mcu_doctor` 检查随包运行时和实际串口，按当前接线选择端口。
2. 对已有 HEX 先调用 `mcu_flash` 并设置 `dryRun: true`，核对型号、频率、字节数和 SHA256。
3. 确认要写入的固件和目标后，开始真实烧录，再按板载下载键或冷启动 MCU。端口由插件占用时不要另开官方软件下载。
4. 查看实际阶段确认、进程关闭和错误回执；需要时单独冷启动读取状态，再核对板上功能。

`expectedUid` 是可选的已知 7 字节 UID（14 个十六进制字符），仅用于 F449/7.2.5S/内部 IRC 的有界擦除应答接收。
UID 在擦除 ACK 中核对，**不能防止先擦错目标**；不符时停止后续编程。没有该参数时保留原严格接收路径。
`dryRun` 不核验实际芯片身份。应用 ID 绑定代码/选项意图，不能代替对实际目标和固件的确认。

硬件选项 apply 使用完整代码重刷和重新校准，不是无损单独写选项。
共享 IAP 与代码共用 Flash；恢复代码不等于恢复未备份的数据。独立 EEPROM 保代码写入、
精确物理擦除范围及主机 ISP 独立 Flash/EEPROM 读回仍未支持；`verify: true` 明确拒绝。
实验性 `clockMode: preserve` 尚未实机通过，不作为失败后的自动降级。

## 配置与运行时

数据目录默认为 `~/.dsh-mcu51`，可通过 `dataDir` 或 `DSH_MCU51_DATA` 指定。
可选配置包括 `defaultPort`、`defaultMcu`、`flashWaitSeconds`、`keilPath`；端口不默认采用开发机 COM9。
项目、日志、取模预览写入用户数据目录。旧 GUI/外部烧录器配置不再执行，会返回迁移提示。

完整包包含隔离 CPython、pyserial、stcgal、Pillow 等；不需要安装 Python 或 pip。
运行时低于 Windows Medium 完整性时会明确报告 `RUNTIME_LOW_INTEGRITY`；
请将完整包正常解压到普通用户应用目录再检查，不需要自动提权、修改 ACL 或改锁目录。
串口操作使用同用户跨进程 OS 锁，取消等待子进程关闭，失败保留部分状态，不自动重试擦写。

## 开发与许可证

插件自身代码采用 [MIT](LICENSE)，第三方组件各自遵循 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
官方 EXE、GUI、全量反汇编、Keil 和 Microsoft 字体不包含在发行包中。

维护者从匹配版本的 CPython 和固定开源依赖执行 `scripts/bundle_runtime.py` 重建运行时，
再执行 `scripts/package_release.py` 和 `scripts/verify_release.py`。使用者无需执行构建步骤。
解包后可用 `node --test test/*.test.mjs` 检查 JS，以及随包 Python 的 `-I -B` 执行 Python 测试。
`node test/smoke.mjs` 默认只执行离线/dryRun 调用，不打开物理串口；可选编译测试需显式设置 `DSH_MCU51_SMOKE_PROJECT`。
