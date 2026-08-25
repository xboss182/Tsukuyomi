<script setup lang="ts">
import InputText from 'primevue/inputtext';
import Checkbox from 'primevue/checkbox';
import { injectNovelImport } from 'src/composables/novel-import/useNovelImport';

const ctx = injectNovelImport();
</script>

<template>
  <div class="space-y-2">
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

    <!-- Private-use acknowledgement for Kakuyomu -->
    <div
      v-if="ctx.needsPrivateUseAck.value"
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
  </div>
</template>
