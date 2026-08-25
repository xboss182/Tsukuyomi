<script setup lang="ts">
import { computed } from 'vue';
import Dialog from 'primevue/dialog';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Checkbox from 'primevue/checkbox';
import ProgressBar from 'primevue/progressbar';
import { injectNovelImport } from 'src/composables/novel-import/useNovelImport';
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

const showUrlInput = computed(() => ctx.step.value === 'idle' || ctx.step.value === 'unsupported');
const showPreview = computed(() => ctx.step.value === 'preview' && ctx.snapshot.value);
const showProgress = computed(() => ctx.isBusy.value && !showPreview.value);
const showResult = computed(() =>
  ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(ctx.step.value),
);
const chapters = computed(() => ctx.snapshot.value?.chapters ?? []);

function chapterLabel(chapter: RemoteChapterStub): string {
  return chapter.title;
}

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
    <div class="novel-import-dialog-body space-y-4">
      <!-- URL input -->
      <div v-if="showUrlInput" class="space-y-2">
        <label for="novel-import-url" class="block text-sm font-medium text-moon/90">
          小说 URL
        </label>
        <InputText
          id="novel-import-url"
          v-model="ctx.url.value"
          class="w-full"
          placeholder="输入 Kakuyomu / Narou / NoBadNovel / FreeWebNovel / NovelLunar 的 URL"
          aria-describedby="novel-import-url-help"
          @keyup.enter="ctx.preview"
        />
        <small id="novel-import-url-help" class="block text-moon/60">
          粘贴作品首页地址，系统将解析目录并显示预览。
        </small>
        <div
          v-if="ctx.step.value === 'unsupported' && ctx.url.value"
          class="text-sm text-red-400"
          role="alert"
        >
          不支持的来源 URL，请检查链接格式。
        </div>
      </div>

      <!-- Private-use acknowledgement for Kakuyomu -->
      <div
        v-if="ctx.needsPrivateUseAck.value && showUrlInput"
        class="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20"
      >
        <Checkbox
          :model-value="ctx.privateUseAcknowledged.value"
          :binary="true"
          input-id="private-use-ack"
          @update:model-value="ctx.acknowledgePrivateUse"
        />
        <label for="private-use-ack" class="text-sm text-moon/90 cursor-pointer">
          我确认该 Kakuyomu 导入仅供个人使用，并遵守其服务条款。
        </label>
      </div>

      <!-- Preview -->
      <div v-if="showPreview" class="space-y-3">
        <div class="card-base p-4 space-y-2">
          <h3 class="text-lg font-semibold text-moon/90">
            {{ ctx.snapshot.value?.title }}
          </h3>
          <p v-if="ctx.snapshot.value?.author" class="text-sm text-moon/70">
            作者：{{ ctx.snapshot.value.author }}
          </p>
          <p
            v-if="ctx.snapshot.value?.description"
            class="text-sm text-moon/80 whitespace-pre-wrap"
          >
            {{ ctx.snapshot.value.description }}
          </p>
          <div class="text-sm text-moon/70">
            来源：{{ ctx.sourceLabel.value }} · 章节：{{ chapters.length }}
          </div>
        </div>

        <div class="max-h-64 overflow-y-auto border border-white/10 rounded-lg p-2">
          <div
            v-for="chapter in chapters"
            :key="chapter.remoteChapterId"
            class="flex items-center gap-2 py-1 px-2 hover:bg-white/5 rounded"
          >
            <Checkbox
              :model-value="ctx.selectedChapters.value.has(chapter.remoteChapterId)"
              :binary="true"
              @update:model-value="ctx.toggleChapter(chapter.remoteChapterId)"
            />
            <span class="text-sm text-moon/90">{{ chapterLabel(chapter) }}</span>
          </div>
        </div>
      </div>

      <!-- Progress -->
      <div v-if="showProgress" class="space-y-3" aria-live="polite" aria-atomic="true">
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

      <!-- Result -->
      <div v-if="showResult" class="space-y-3">
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
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <Button
          v-if="!ctx.isBusy.value"
          label="关闭"
          class="p-button-text"
          @click="resetAndClose"
        />
        <Button
          v-if="showUrlInput"
          label="预览"
          :disabled="!ctx.canPreview.value"
          @click="ctx.preview"
        />
        <Button
          v-if="showPreview"
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
