<script setup lang="ts">
import { injectNovelImport } from 'src/composables/novel-import/useNovelImport';

const ctx = injectNovelImport();
</script>

<template>
  <div class="space-y-3">
    <div
      v-if="ctx.step.value === 'failed'"
      class="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-300"
      role="alert"
    >
      {{ ctx.error.value?.message ?? '导入失败' }}
    </div>
    <div
      v-else-if="ctx.step.value === 'cancelled'"
      class="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-sm text-yellow-300"
      role="alert"
    >
      导入已取消。
    </div>
    <div
      v-else
      class="p-3 rounded-lg bg-green-500/10 border border-green-500/20 text-sm text-green-300"
      role="status"
    >
      导入完成：{{ ctx.progress.value.completed }} 章成功，{{ ctx.progress.value.failed }} 章失败。
    </div>
  </div>
</template>
