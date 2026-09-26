import { z } from "zod";
export const notificationPreferencesInput = z.object({
 expectedVersion: z.number().int().nonnegative(), quietUntil: z.iso.datetime().nullable(),
}).strict();
export type NotificationPreferences = { version: number; quietUntil: string | null; quiet: boolean };
export const notificationLabels: Record<string,string> = {
 "control.requested":"有人申请控制权", "control.accepted":"控制权申请已同意", "control.rejected":"控制权申请已拒绝", "control.withdrawn":"控制权申请已撤回", "control.expired":"控制权申请已失效",
 "task.review_requested":"任务请求评审", "integration.checked":"组合验证通过，待独立评审", "integration.conflicted":"组合存在代码冲突", "integration.check_failed":"组合验证未通过", "integration.unknown":"组合验证结果待核查",
 "ci.failed":"PR 必需检查未通过", "ci.unavailable":"PR 检查读取失败", "repository.baseline":"本地合并完成，仓库基线已更新",
 "gitlab.ready":"MR 已转为待评审", "gitlab.merged":"MR 已合并", "gitlab.ci_failed":"MR 流水线未通过", "gitlab.failed":"GitLab 操作失败", "gitlab.uncertain":"GitLab 操作结果待核查",
 "pull.ready":"PR 已转为待评审", "pull.merged":"PR 已合并", "pull.rejected":"GitHub 拒绝交付", "pull.not_sent":"PR 交付未发送", "pull.unknown":"PR 交付结果待核对",
 mention:"提及了你", "discussion.message":"讨论有新回复", "discussion.state":"讨论状态已更新",
 "run.completed":"运行结束", "run.failed":"运行失败", "run.cancelled":"运行已停止", "run.reconciling":"运行需要核对", "run.waiting_input":"运行等待输入",
};
