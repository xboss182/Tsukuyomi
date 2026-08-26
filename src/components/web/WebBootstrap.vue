<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { injectWebAuth } from 'src/composables/web-app/useWebApp';
import WebLoginPage from './WebLoginPage.vue';

const { t } = useI18n();
const auth = injectWebAuth();

const authState = computed(() => auth?.state.value ?? 'unknown');
</script>

<template>
  <div class="web-bootstrap">
    <slot v-if="authState === 'authenticated'" />
    <WebLoginPage v-else-if="authState === 'unauthenticated'" />
    <span aria-live="polite">{{ t('webAuth.verifyingSession') }}</span>
  </div>
</template>
