<script setup lang="ts">
import { computed } from 'vue';
import { injectWebAuth } from 'src/composables/web-app/useWebApp';
import Button from 'primevue/button';

const auth = injectWebAuth();

const isUnauthenticated = computed(() => auth?.state.value === 'unauthenticated');

async function logout(): Promise<void> {
  await auth?.logout();
}
</script>

<template>
  <div class="web-header-actions">
    <Button
      v-if="isUnauthenticated"
      label="登录"
      class="p-button-text p-button-sm"
      icon="pi pi-sign-in"
      @click="$emit('login')"
    />
    <Button
      v-else
      label="退出"
      class="p-button-text p-button-sm"
      icon="pi pi-sign-out"
      @click="logout"
    />
  </div>
</template>

<style scoped>
.web-header-actions {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}
</style>
