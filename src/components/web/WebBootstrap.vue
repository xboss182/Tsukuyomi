<script setup lang="ts">
import { computed } from 'vue';
import { injectWebAuth } from 'src/composables/web-app/useWebApp';
import WebLoginPage from './WebLoginPage.vue';

const auth = injectWebAuth();

const authState = computed(() => auth?.state.value ?? 'unknown');
</script>

<template>
  <div class="web-bootstrap">
    <slot v-if="authState === 'authenticated'" />
    <WebLoginPage v-else-if="authState === 'unauthenticated'" />
    <span aria-live="polite">正在验证会话</span>
  </div>
</template>
