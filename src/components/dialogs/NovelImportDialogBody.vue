<script setup lang="ts">
import { computed } from 'vue';
import InputText from 'primevue/inputtext';
import Checkbox from 'primevue/checkbox';
import ProgressBar from 'primevue/progressbar';
import { injectNovelImportDialog } from 'src/composables/novel-import/useNovelImportDialog';
import NovelImportUrlInput from './NovelImportUrlInput.vue';
import NovelImportPreview from './NovelImportPreview.vue';
import NovelImportProgress from './NovelImportProgress.vue';
import NovelImportResult from './NovelImportResult.vue';

const ctx = injectNovelImportDialog();

const showUrlInput = computed(() => ctx.step.value === 'idle' || ctx.step.value === 'unsupported');
const showPreview = computed(() => ctx.step.value === 'preview' && ctx.snapshot.value);
const showProgress = computed(() => ctx.isBusy.value && !showPreview.value);
const showResult = computed(() =>
  ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(ctx.step.value),
);
</script>

<template>
  <div class="novel-import-dialog-body space-y-4">
    <NovelImportUrlInput v-if="showUrlInput" />
    <NovelImportPreview v-if="showPreview" />
    <NovelImportProgress v-if="showProgress" />
    <NovelImportResult v-if="showResult" />
  </div>
</template>
