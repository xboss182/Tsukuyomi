<script setup lang="ts">
import { ref, watch } from 'vue';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import Password from 'primevue/password';
import { injectWebAuth } from 'src/composables/web-app/useWebApp';

const auth = injectWebAuth();
const password = ref('');
const showPassword = ref(false);

watch(
  () => auth?.error.value,
  (error) => {
    if (!error) password.value = '';
  },
);

async function submit(): Promise<void> {
  if (!auth || !password.value) return;
  await auth.login(password.value);
}
</script>

<template>
  <div class="web-login">
    <div class="web-login-card">
      <h1 class="web-login-title">Tsukuyomi</h1>
      <p class="web-login-subtitle">输入访问密码以继续使用</p>
      <form class="web-login-form" @submit.prevent="submit">
        <label for="web-login-password" class="sr-only">访问密码</label>
        <Password
          v-if="showPassword"
          id="web-login-password"
          v-model="password"
          class="w-full"
          input-class="w-full"
          toggle-mask
          :feedback="false"
          placeholder="访问密码"
          @keyup.enter="submit"
        />
        <InputText
          v-else
          id="web-login-password"
          v-model="password"
          class="w-full"
          type="password"
          placeholder="访问密码"
          @keyup.enter="submit"
        />
        <Button
          type="submit"
          label="登录"
          :loading="auth?.isLoading.value"
          :disabled="!password || auth?.isLoading.value"
          class="w-full"
        />
      </form>
      <p v-if="auth?.error.value" class="web-login-error" role="alert">
        {{ auth.error.value }}
      </p>
      <button
        type="button"
        class="web-login-toggle"
        @click="showPassword = !showPassword"
      >
        {{ showPassword ? '隐藏密码' : '显示密码' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.web-login {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 1.5rem;
}

.web-login-card {
  width: 100%;
  max-width: 22rem;
  padding: 2rem;
  border-radius: 1rem;
  border: 1px solid var(--white-opacity-8, rgba(255, 255, 255, 0.08));
  background: var(--surface-card, rgba(8, 10, 13, 0.65));
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.web-login-title {
  margin: 0;
  font-family: 'Noto Serif JP', 'Songti SC', serif;
  font-size: 1.5rem;
  text-align: center;
  color: var(--moon-opacity-95);
}

.web-login-subtitle {
  margin: 0;
  text-align: center;
  font-size: 0.85rem;
  color: var(--moon-opacity-65);
}

.web-login-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.web-login-error {
  margin: 0;
  text-align: center;
  font-size: 0.85rem;
  color: var(--red-400, #f87171);
}

.web-login-toggle {
  background: transparent;
  border: none;
  color: var(--accent-silver);
  font-size: 0.78rem;
  cursor: pointer;
  text-align: center;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border-width: 0;
}
</style>
