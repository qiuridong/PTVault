# 离线恢复：先准备材料，再验证能恢复

在自己的可信电脑、交互终端运行仓库中的 `deploy/recovery/prepare-recovery.sh`
（Linux/macOS）或 `deploy/recovery/prepare-recovery.ps1`（PowerShell 7+）。
需要真实 age 和 age-keygen。助手会生成公钥与口令加密的私钥托管件，真实 age 自己提示口令；
助手不接收口令。已有输出目录会被拒绝，临时明文会清理，但不保证 SSD/快照的物理擦除。

1. 将 public recipient 登记到恢复页；上传加密的 recovery-key.age 作为 escrow，不上传明文私钥。
2. 正常生成新恢复版本、下载原加密文件，将恢复页所选版本的云端路径和 SHA 一起离线保存。
3. 在另一目录/电脑正常授权 raw 云账户，从所记录路径取回 bundle.tar.age 和 escrow.age。
   新副本位于 raw remote 的 ptvault-recovery/ 下，不需要先配置 crypt。
4. 在可信本机执行：

   ```sh
   umask 077
   age -d -o identity.key escrow.age
   age -d -i identity.key -o recovery.tar bundle.tar.age
   tar -xf recovery.tar
   ```

5. 包内 rclone.conf 已去掉 OAuth token；重新授权 raw 后端，但保留每个 crypt profile
   原有 password/password2。它们是恢复数据必需的密钥，不可重新生成来“修复”旧数据。
   根据 accounts.json 与数据库中的 offload_files / import_objects 对应表取回并校验对象。
6. 实际完成后，再在网页登记下载确认和口令演练；页面确认不会替用户验证解密。

这不是“两把独立数据密钥”：age 私钥能解包并读取 crypt 密钥，必须保密。
历史 escrow 的明文类型未由服务器核验，可能是 crypt 口令而非 age 私钥。
旧 crypt:recovery/vN 路径仍需要原 crypt 密钥；不会自动迁移、重解释或覆盖旧材料。
先核对历史材料，保留对应 age 私钥及原离线下载件，再按新版本演练，绝不删除唯一备份。

软件验证不等于你的真实云账户灾难恢复已验证；请保持原数据，独立演练成功后再使用清理功能。
