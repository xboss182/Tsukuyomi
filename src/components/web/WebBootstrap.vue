<script setup lang="ts">
import { computed } from 'vue';
import { injectWebAuth } from 'src/composables/web-app/useWebApp';
import WebLoginPage from './WebLoginPage.vue';

const auth = injectWebAuth();

const showLogin = computed(() => auth?.state.value === 'unauthenticated');
</script>

<template>
  <div class="web-bootstrap">
    <slot v-if="!showLogin" />
    <WebLoginPage v-else />
  </div>
</template>
