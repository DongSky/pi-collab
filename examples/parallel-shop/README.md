# 双人真实 AI 验收项目

这是故意保留两个未实现函数的练习仓库。初始测试应失败，不能把模板本身算作完成的应用。

- Alice 仅实现 `pricing.mjs`，运行 `node --test tests/pricing.test.mjs`。
- Bob 仅实现 `shipping.mjs`，运行 `node --test tests/shipping.test.mjs`。
- `checkout.mjs` 与 tests 是固定验收输入，AI 不得修改。
- 两人从同一 Git 基线进入不同工作区。各自验证后发布成果，整合区运行所有测试。
- 原始练习仓库保持不变；通过的实际代码保存在 pi-collab 的任务工作区和整合证据中。

这验证实际模型写代码、工作区隔离和组合检查；不代表 PR、生产部署或全部协作能力已验收。
