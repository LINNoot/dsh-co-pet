# 宠物包目录

把宠物包文件夹放到这里（结构同 Codex）：

```text
pets/我的宠物/
  pet.json          # 可选：id / displayName / description / spriteVersionNumber
  spritesheet.webp  # 8 列；9 行（v1，192x208/格）或 11 行（v2）
```

本仓库**不随源码分发宠物素材**（素材授权通常不明确）。宠物包可放在：

- 本目录 `pets/`（应用目录优先）；或
- `~/.dsh/pets/`（用户目录，升级应用不丢失）。
