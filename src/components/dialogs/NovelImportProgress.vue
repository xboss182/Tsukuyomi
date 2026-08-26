<script setup lang="ts">
import ProgressBar from 'primevue/progressbar';
import { injectNovelImportDialog } from 'src/composables/novel-import/useNovelImportDialog';

const ctx = injectNovelImportDialog();
</script>

<template>
  <div class="space-y-3" aria-live="polite" aria-atomic="true">
    <div class="flex items-center justify-between text-sm text-moon/80">
      <span>{{ ctx.step.value }}</span>
      <span>{{ ctx.progress.value.completed }} / {{ ctx.progress.value.total }}</span>
    </div>
    <ProgressBar
      v-if="ctx.progress.value.total > 0"
      :value="Math.round((ctx.progress.value.completed / ctx.progress.value.total) * 100)"
    />
    <ProgressBar v-else mode="indeterminate" />
  </div>
</template>
