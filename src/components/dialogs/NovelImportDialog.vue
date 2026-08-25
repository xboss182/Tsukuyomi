<script setup lang="ts">
import { computed } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Checkbox from 'primevue/checkbox';
import ProgressBar from 'primevue/progressbar';
import { injectNovelImport } from 'src/composables/novel-import/useNovelImport';
import NovelImportDialogBody from './NovelImportDialogBody.vue';
import type { RemoteChapterStub } from 'src/models/importer';

const props = defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  'update:visible': [value: boolean];
}>();

const ctx = injectNovelImport();

const dialogVisible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value),
});

const title = computed(() => {
  if (ctx.step.value === 'preview') return '导入预览';
  if (ctx.step.value === 'failed') return '导入失败';
  if (ctx.step.value === 'completed_with_errors') return '导入完成（部分失败）';
  return '从网站导入';
});

function closeDialog(): void {
  emit('update:visible', false);
}

function resetAndClose(): void {
  ctx.clear();
  closeDialog();
}
</script>

<template>
  <Dialog
    v-model:visible="dialogVisible"
    :header="title"
    modal
    :closable="!ctx.isBusy.value"
    :dismissable-mask="!ctx.isBusy.value"
    :style="{ width: '36rem', maxWidth: '95vw' }"
  >
    <NovelImportDialogBody />

    <template #footer>
      <div class="flex justify-end gap-2">
        <Button
          v-if="!ctx.isBusy.value"
          label="关闭"
          class="p-button-text"
          @click="resetAndClose"
        />
        <Button
          v-if="ctx.step.value === 'idle' || ctx.step.value === 'unsupported'"
          label="预览"
          :disabled="!ctx.canPreview.value"
          @click="ctx.preview"
        />
        <Button
          v-if="ctx.step.value === 'preview'"
          label="导入"
          :disabled="!ctx.canImport.value"
          @click="ctx.confirmImport"
        />
        <Button
          v-if="ctx.step.value === 'completed_with_errors'"
          label="重试失败章节"
          class="p-button-warning"
          @click="ctx.retryFailed"
        />
        <Button
          v-if="ctx.isBusy.value"
          label="取消"
          class="p-button-danger"
          :loading="ctx.step.value === 'cancelled'"
          @click="ctx.cancel"
        />
      </div>
    </template>
  </Dialog>
</template>
