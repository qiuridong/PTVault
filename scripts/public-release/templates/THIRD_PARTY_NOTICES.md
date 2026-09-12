# 第三方组件与源码材料

PTVault 自有代码采用根目录 `LICENSE` 中的 MIT 许可。该许可不会覆盖或替代第三方组件的许可。

- **Node.js 与其随附组件**：完整声明在 `licenses/Node.js-LICENSE.txt`，原官方运行时许可也保留在 `runtime/node/LICENSE`。
- **rclone**：本体声明在 `licenses/rclone-COPYING.txt`；固定版本 vendor 中的许可、NOTICE 与 PATENTS 文件另放在 `licenses/rclone-dependencies/`。对应本体/vendor 源码随同版本 sources 资产提供。
- **age / age-keygen**：声明在 `licenses/age-LICENSE.txt`，包含 age 与 Go 作者声明；依赖模块的许可在 `licenses/age-dependencies/`。固定源代码及经原 go.sum 校验的运行依赖 ZIP 随 sources 资产提供，细项见 `GO_COMPONENTS.json`。
- **7-Zip / 7zzs**：`licenses/7-Zip-License.txt` 与 `licenses/7-Zip-license.htm` 保留 LGPL、BSD 及 unRAR 限制。未将这些组件改称 MIT；对应固定源码随 sources 资产提供。
- **FFmpeg / ffprobe**：按 `RUNTIME_MANIFEST.json` 所记参数构建，未启用 GPL、nonfree、version3 或网络协议；具体条款、例外与作者见 `licenses/FFmpeg-*`。私有共享库与对应源码/构建参数一起提供。系统库的精确发行版源码与补丁见 sources 资产中的 `runtime/system-*`。
- **npm 组件**：`NPM_COMPONENTS.json` 列出本次实际安装的构建及运行依赖、版本、作者、原始分发 URL 与完整性值；部分组件仅用于构建，并不进入业务运行图。原许可文本汇总在 `licenses/npm/`，也识别 `LICENSE-MIT` 等名称。上游未单列许可文件时，保留原 README、包元数据与含版权声明的源文件；标准许可补充说明见 `licenses/npm/ADDITIONAL_NOTICES.md`。运行时 node_modules 自带的源文件和许可不删除。
- **字体**：Inter、JetBrains Mono、Bricolage Grotesque 的 OFL 全文及版权在网页 `fonts/` 和公开源码的字体目录中。字体许可证与保留字体名称要求保持。
- **百度默认客户端参考参数**：来自清单固定的公开 AList 参考。只提取数据参数，不编译或链接其 Go 代码；原参考源和 AGPL 文本独立保留，不包含使用者的登录凭据。

发行时应同时提供同版本 `linux-x64`、`sources` 资产和 `SHA256SUMS`。使用者可以查看、修改并重建对应的开放源码组件；校验清单用于检测发行文件变化，不限制本机管理员按许可证替换或重建组件。自行更换后应重新执行功能与沙箱验证，不能继续沿用旧校验结果。

本包不会代替云服务提供商授予账号、应用或内容的使用权限。默认客户端能否继续提供服务取决于提供方，向导也支持填写自己的客户端参数。
