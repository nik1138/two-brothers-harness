<script setup lang="ts">
defineProps<{ messages: string[] }>()
const emit = defineEmits<{ dismiss: [index: number] }>()
</script>

<template>
  <div v-if="messages.length" class="toast-stack" role="alert" aria-live="assertive">
    <div v-for="(m, i) in messages" :key="i" class="toast">
      <span class="toast-text">{{ m }}</span>
      <button class="toast-close" :aria-label="`Dismiss error ${i + 1}`" @click="emit('dismiss', i)">×</button>
    </div>
  </div>
</template>
