# 自托管字体

三款字体均为 **SIL Open Font License 1.1**，允许自托管与商用，随构建产物一起分发。
自托管而不是引 Google Fonts CDN 的两个理由：① 控制面在登录墙后面，不该让第三方看到谁在什么时候访问；
② 字体一旦走外网，链路忙的时候首屏会先渲染回退字体再跳字。

| 文件 | 字体 | 上游 | 用途 |
|---|---|---|---|
| `bricolage-latin*.woff2` | Bricolage Grotesque（可变：opsz / wdth / wght） | <https://github.com/ateliertriay/bricolage> | 大标题、数字大字 |
| `inter-latin*.woff2` | Inter（可变：wght） | <https://github.com/rsms/inter> | 正文与界面 |
| `jetbrains-latin*.woff2` | JetBrains Mono（可变：wght） | <https://github.com/JetBrains/JetBrainsMono> | 哈希、路径、字节数、速率 |

**只含 latin 与 latin-ext 子集**：中文走系统自带 CJK 字体。一款中文显示字体动辄几 MB，
较小的字体子集可减少页面与迁移任务争用带宽。`unicode-range` 保证 latin-ext
那几个切片只有真的用到带变音符号的字母时才下载。

更新字体时：从上游取 woff2，替换同名文件，`src/styles/fonts.css` 里的 `unicode-range` 不用动。

完整许可与版权声明随本目录分发，不由项目 MIT 替代：

- [Inter OFL](inter-OFL.txt)，当前文件元数据版本 4.001，版权为 Inter Project Authors。
- [JetBrains Mono OFL](jetbrains-OFL.txt)，当前文件元数据版本 2.211，版权为 JetBrains Mono Project Authors。
- [Bricolage Grotesque OFL](bricolage-OFL.txt)，当前文件元数据版本 1.001，版权为 Bricolage Grotesque Project Authors。

三份完整许可分别来自上表所列官方仓库。当前六个 WOFF2 的版权和版本已使用字体解析器读取核对；子集文件保持原字节，没有转换或重新命名字体。
