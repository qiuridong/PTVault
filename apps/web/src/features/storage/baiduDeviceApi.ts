import {
  BaiduDeviceFlowSchema,
  BaiduDeviceInfoSchema,
  BaiduDeviceStartSchema,
  type BaiduDeviceStart,
} from '@ptvault/contracts';
import { apiControlMutation, apiGet, apiMutation } from '../../api/client.js';
const base = '/api/storage/connections/baidu-device';
export const getBaiduDeviceInfo = () => apiGet(`${base}/info`, BaiduDeviceInfoSchema);
export const startBaiduDevice = (body: BaiduDeviceStart, key: string) =>
  apiControlMutation(`${base}/start`, BaiduDeviceStartSchema.parse(body), BaiduDeviceFlowSchema, {
    idempotencyKey: key,
  });
export const pollBaiduDevice = (id: string) =>
  apiMutation(`${base}/flows/${encodeURIComponent(id)}/poll`, {}, BaiduDeviceFlowSchema);
export const cancelBaiduDevice = (id: string) =>
  apiMutation(`${base}/flows/${encodeURIComponent(id)}/cancel`, {}, BaiduDeviceFlowSchema);
