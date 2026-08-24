/**
 * Electron API 类型声明
 * 通过 preload 脚本暴露给渲染进程的 API
 */
import type { ImportFetchRequest, ImportFetchResult } from 'src/models/importer';

export interface ElectronAPI {
  /** 受来源策略约束的导入请求，不是通用 HTTP 代理。 */
  importFetch: (request: ImportFetchRequest) => Promise<ImportFetchResult>;

  /**
   * 通过 Electron 的 net 模块发起 HTTP 请求
   * 避免浏览器的 CORS 限制
   */
  fetch: (
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      timeout?: number;
    },
  ) => Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    data: string;
  }>;

  /**
   * 检查是否在 Electron 环境中
   */
  isElectron: boolean;

  /**
   * 获取 Electron 版本信息
   */
  versions: {
    node: () => string;
    chrome: () => string;
    electron: () => string;
  };

  /**
   * 提供商凭据管理
   */
  providerCredentials: {
    list: () => Promise<{ ok: true; credentials: unknown[] } | { ok: false; error: string }>;
    upsert: (input: unknown) => Promise<{ ok: true; summary: unknown } | { ok: false; error: string }>;
    remove: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  };

  /**
   * 提供商路由的受约束导入请求
   */
  providerImportFetch: (request: ImportFetchRequest) => Promise<ImportFetchResult>;

  /**
   * 设置相关的 IPC 通信
   */
  settings: {
    /**
     * 注册导出设置请求监听器
     * @param callback 回调函数（可以是异步的）
     * @returns 清理函数，调用它来移除这个监听器
     */
    onExportRequest: (callback: (filePath: string) => void | Promise<void>) => () => void;
    /**
     * 注册导入设置数据监听器
     * @param callback 回调函数
     * @returns 清理函数，调用它来移除这个监听器
     */
    onImportData: (callback: (content: string) => void) => () => void;
    saveExport: (filePath: string, data: string) => void;
    removeListeners: () => void;
  };
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
