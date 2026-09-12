import { z } from 'zod';
import {
  CreateImportRequestSchema,
  ImportPipelineSummarySchema,
  ImportPipelineDetailSchema,
  GroupSettingsStatusSchema,
  GroupSettingsPatchSchema,
  PipelineObservationResponseSchema,
  type CreateImportRequest,
  type ImportPipelineSummary,
  type GroupSettingsPatch,
  type PipelineObservationResponse,
} from '@ptvault/contracts';
import { ApiError, apiControlMutation, apiGet, apiMutation } from '../../api/client.js';
import type { Probe } from '../../api/probe.js';
import { importErrorMessage } from './importApi.js';

export const groupPipelinesQueryKey = ['imports', 'pipelines'] as const;
export const groupSettingsQueryKey = ['group-pipeline-settings'] as const;
const pipelineResponse = z.object({ pipeline: ImportPipelineSummarySchema });
const id = (value: string) => encodeURIComponent(z.string().uuid().parse(value));
export async function getGroupPipelines() {
  return (
    await apiGet(
      '/api/import-pipelines',
      z.object({ pipelines: z.array(ImportPipelineSummarySchema).max(100) }),
    )
  ).pipelines;
}
export async function getGroupPipeline(pipelineId: string, offset: number) {
  return (
    await apiGet(
      `/api/import-pipelines/${id(pipelineId)}?offset=${offset}&limit=20`,
      z.object({ pipeline: ImportPipelineDetailSchema }),
    )
  ).pipeline;
}
export async function createGroupPipeline(
  request: CreateImportRequest,
): Promise<Probe<ImportPipelineSummary>> {
  const body = CreateImportRequestSchema.parse(request);
  if (body.processingMode !== 'GROUPED_VIDEO' || body.sourceCleanupPolicy !== 'KEEP')
    throw Error('GROUP_CREATE_ACKNOWLEDGEMENT_REQUIRED');
  try {
    return {
      supported: true,
      data: (await apiMutation('/api/import-pipelines', body, pipelineResponse)).pipeline,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code !== 'IMPORT_PLAN_NOT_FOUND')
      return { supported: false };
    throw error;
  }
}
export async function actOnGroupPipeline(
  pipelineId: string,
  action: 'PAUSE' | 'RESUME' | 'CANCEL' | 'RETRY',
  key: string,
) {
  return (
    await apiControlMutation(
      `/api/import-pipelines/${id(pipelineId)}/${action.toLowerCase()}`,
      {},
      pipelineResponse,
      { idempotencyKey: key },
    )
  ).pipeline;
}
export const getGroupSettings = () =>
  apiGet('/api/import-pipelines/settings', GroupSettingsStatusSchema);
export const saveGroupSettings = (patch: GroupSettingsPatch, key: string) =>
  apiControlMutation(
    '/api/import-pipelines/settings',
    GroupSettingsPatchSchema.parse(patch),
    GroupSettingsStatusSchema,
    { method: 'PATCH', idempotencyKey: key },
  );
export function observationQuery(from: number, to: number): string {
  return `from=${Math.floor(from)}&to=${Math.floor(to)}&maxPoints=240`;
}
export function getGroupObservations(
  from: number,
  to: number,
): Promise<PipelineObservationResponse> {
  return apiGet(
    `/api/import-pipelines/observations?${observationQuery(from, to)}`,
    PipelineObservationResponseSchema,
  );
}
export function groupErrorMessage(error: unknown): string {
  const messages: Record<string, string> = {
    GROUP_SETTINGS_REVISION_CONFLICT: '服务端配置已更新。请加载最新配置后再保存；当前草稿仍保留。',
    GROUP_SETTINGS_INVALID: '分组并发应为 1–8，且各阶段不超过驻盘组数；请检查暂存缓存值。',
    GROUP_SETTINGS_IDEMPOTENCY_CONFLICT: '这次重试的内容与原请求不同，请刷新配置后再保存。',
    GROUP_PARENT_PAUSED: '父流水线仍处于暂停状态。密码可以保存，恢复执行请先恢复父流水线。',
    GROUP_PARENT_CANCELLED: '父流水线已取消，已完成组和已验证云备份保持不变。',
    GROUP_PIPELINE_NOT_FOUND: '该分组流水线不存在，请返回列表核对。',
    GROUP_OBSERVATION_UNAVAILABLE: '服务端尚未配置观测历史，迁移执行不受影响。',
    GROUP_OBSERVATION_QUERY_INVALID: '请选择不超过 30 天的观测窗口。',
    GROUP_PLAN_IDENTITY_UNVERIFIED: '服务端返回的分组计划与本次选择不一致，请重新生成计划。',
    MFA_FAILED: '验证码校验未通过，请输入当前六位验证码。',
  };
  const code = error instanceof ApiError ? error.code : error instanceof Error ? error.message : '';
  return (code ? messages[code] : undefined) ?? importErrorMessage(error);
}
