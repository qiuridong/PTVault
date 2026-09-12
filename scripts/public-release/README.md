# 公开版发行工具

构建工具只产生本地候选，不创建 GitHub 仓库、不推送 Git，也不连接既有生产服务。安装工具是单独、显式的 root 操作，仅管理 `ptvault-public` 的独立路径和服务。不要在承载其他部署的机器上试跑安装验收。

## 1. 从当前源码导出干净副本

在项目根目录运行，需要 Node.js 24：

```sh
node scripts/public-release/export-source.mjs /absolute/new-source-directory 0.1.0-dev.1
```

目标父目录需已存在，目标目录必须不存在。只导出明确白名单中的生产源码、构建配置、字体许可和发行工具，不按 Git 跟踪文件或整个工作目录打包。共置业务测试、历史部署样本、私密配置、日志及历史资料不导出。源码中的私人名称仍需人工审查，自动内容检查不保证检出所有敏感信息。

`PUBLIC_SOURCE_MANIFEST.json` 在最后写入，是完整快照的标记，记录相对路径、文件大小和 SHA-256。中断目录会保留，不自动覆盖或递归清理。依赖锁仅规范化已知 npm 镜像地址，不更改版本或完整性值；公开构建按 contracts → API → Web 执行。

```sh
node --test scripts/public-release/*.test.mjs
python3 -m unittest discover -s scripts/public-release -p 'test_*.py'
```

## 2. 在独立 Ubuntu 24.04 x86-64 构建运行时

不要在承载迁移任务的生产服务器上安装编译依赖。使用一次性 VM 或专用构建环境，准备 Python 3.12+、make、GCC/G++、binutils、pax-utils/lddtree、python3-pyelftools 和 pkg-config。构建环境需要已启用、带 Ubuntu 签名验证的 `deb-src` 索引；工具本身不改 apt 源，也不会安装或升级系统包。

在干净源码副本内运行：

```sh
python3 scripts/public-release/build_runtime.py \
  --cache /absolute/runtime-download-cache \
  --output /absolute/new-runtime-output \
  --jobs 2
```

- 下载输入由 `runtime-lock.json` 固定 URL 与 SHA-256，不使用 latest。缓存命中仍校验，不覆盖损坏的旧缓存；失败的独立临时下载保留供诊断。
- 使用独立 Node.js 24 运行时，不修改系统 Node。rclone、age 和静态 7zzs 均来自固定官方发行包。
- ffprobe 由固定 FFmpeg 8.0.3 源码构建，关闭网络、自动探测外部依赖、GPL/nonfree/version3 功能；保留内部媒体探测所需解封装器、解析器和解码器。8.0.3 是本轮选定的维护分支版本，不声称它是所有 FFmpeg 分支中的最新版本。
- 媒体探测使用私有 loader 和依赖闭包，均复制为普通文件，不引用构建机上的 symlink。实际执行私有 loader 的版本检查；这仍不代替目标环境的 Landlock/FUSE 验收。
- 对随包复制的系统库，按实际已安装的 source package/version 下载精确对应源码，保留发行版补丁与声明，不用其他版本替代。
- 默认百度客户端只提取固定公开参考中的参数，并复核客户端指纹。原参考源码及其 AGPL 许可独立保留；它不包含使用者的 token、密码或验证码，也不会被编译或链接进 PTVault。

成功后输出 `runtime/`、`licenses/`、`third-party-sources/` 和 `RUNTIME_MANIFEST.json`。清单只有全部构建完成才生成。**运行时构建完成不等于安装包完成**，此阶段不会安装 systemd 服务或创建业务账号。

## 3. 构建二进制、源码与许可资产

在同一独立 Linux 构建环境运行：

```sh
python3 -B scripts/public-release/build_release.py \
  --source /absolute/manifest-bound-source \
  --runtime /absolute/completed-runtime-output \
  --output /absolute/new-release-output
```

程序重新检查源码清单、固定运行时清单和沙箱 helper 身份，执行独立 Linux npm ci、contracts/API/Web 构建，再创建一份仅生产依赖的目录，实际执行 SQLite、Argon2 与内部CLI。不会把构建依赖树或Windows原生模块直接当作生产依赖；npm版本和原生包以锁与实际运行结果为准。

产物在 `assets/`：

- `ptvault-VERSION-linux-x64.tar.gz`：应用、私有运行时、安装器、systemd模板、完整文件清单与第三方声明。
- `ptvault-VERSION-sources.tar.gz`：公开应用源、构建参数、固定运行时对应源码/发行版补丁、rclone vendor，以及经过 age 原 go.sum 内容校验的运行依赖模块。
- `SHA256SUMS`：以上两个资产的SHA-256。

`THIRD_PARTY_NOTICES.md`、`NPM_COMPONENTS.json`、`GO_COMPONENTS.json` 与 `licenses/` 随包提供。rclone vendor 许可按固定源归档提取；Go ZIP以原 go.sum 的h1内容校验，而不是只相信下载成功。归档排序/uid/gid/mtime固定，**不因此宣称不同工具链可以生成逐字节一致的二进制**。

## 4. 在一次性完整 Linux 环境验收

需要真实 systemd/PID1、Landlock 和FUSE，不能以Windows跳过结果或`systemd-analyze verify`替代运行：

1. 校验运行包，执行 `sudo sh scripts/public-release/install.sh`，核对主服务、受保护的LoadCredential和`doctor`。
2. 重复安装，应保留原密钥/配置/账号和已有运行状态，不重复初始化。
3. 真实浏览器完成一次性初始化、正常密码/MFA、草稿/应用、目录读写检查；不要把合成服务商响应标成真实OAuth。
4. 用保留的小样本执行静态7zzs解压、私有ffprobe、越界读写/TCP/UDP拒绝。须在真实服务身份及相应systemd约束下运行。
5. 验证两类受管只读挂载、同路径绝对链接、已有容器命名空间里的新挂载传播；再单独验证真实Jellyfin播放。
6. 存在非终态任务时升级应拒绝；空闲升级/控制面备份应保全既有数据，不倒灌旧token。错误恢复也不能制造“空闲”。
7. 保留数据卸载、原位重装与正常登录应可恢复；清理数据不包含在默认卸载中。

安装器默认仅为自己创建用户、密钥、目录、服务和独立shared导出bind。只有缺依赖时才通过Ubuntu包管理器安装Python3/fuse3；只读FUSE需要时追加`user_allow_other`，不覆盖既有内容。它不改防火墙、SSH、Nginx、Docker、qB或Jellyfin配置。保留数据卸载会停止自己的挂载，不强制处理其他程序占用的挂载。

## GitHub 构建工作流

白名单导出会生成 `.github/workflows/release.yml`。工作流仅允许手动指定版本启动，固定action commit，只拥有`contents: read`。在一次性Ubuntu24.04 runner中构建、实装/重跑/doctor/卸载，然后上传同版本构建资产；不自动发布GitHub Release，也不自动推送源码。这里提供的是工作流实现，不代表它已经在某个公共仓库运行通过。

## 发布边界

正式二进制发行需要同时提供源码/许可材料与校验清单，并核对目标版本的新装、重复安装、正常登录、升级、保留数据卸载及媒体路径证据。不要把不同候选的通过结果混称同一个版本全绿；也不要把本地模拟provider或容器命名空间检查当作真实网盘授权/Jellyfin播放。工具不会自动执行公开发布。
