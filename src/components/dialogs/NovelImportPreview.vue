<script setup lang="ts">
import { computed } from 'vue';
import Checkbox from 'primevue/checkbox';
import { injectNovelImportDialog } from 'src/composables/novel-import/useNovelImportDialog';

const ctx = injectNovelImportDialog();
const chapters = computed(() => ctx.snapshot.value?.chapters ?? []);

function chapterLabel(chapter: { title: string }): string {
  return chapter.title;
}
</script>

<template>
  <div class="space-y-3">
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
</template>
