<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ApiError, getMcpStatus } from '../../api'
import type { McpStatus } from '../../types'
import { MCP_EMPTY_MESSAGE, mcpSectionRows } from '../../mcpStatus'

/**
 * Settings → MCP: a read-only list of the MCP servers the backend knows about
 * (config file or plugin-declared). Editing arrives later; v1 only reports.
 */

const loading = ref(true)
const status = ref<McpStatus | null>(null)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    status.value = await getMcpStatus()
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : String(e)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="mcp-section">
    <p class="settings-lead">
      MCP servers extend both Senior and Junior with external tools. The list is
      read-only here; servers come from the MCP config file or an enabled plugin.
    </p>

    <p v-if="loading" class="mcp-note">Loading MCP servers…</p>
    <p v-else-if="error" class="mcp-error" role="alert">{{ error }}</p>
    <p v-else-if="!status || status.configured.length === 0" class="mcp-note">
      {{ MCP_EMPTY_MESSAGE }}
    </p>

    <div v-else class="mcp-server-list">
      <section v-for="row in mcpSectionRows(status.configured)" :key="row.name" class="mcp-card">
        <header class="mcp-card-head">
          <h3 class="mcp-card-title">{{ row.name }}</h3>
          <span class="mcp-badge">{{ row.badge }}</span>
          <span class="mcp-badge" :class="{ 'mcp-badge-invalid': row.invalid }">{{
            row.transport
          }}</span>
        </header>
        <p class="mcp-card-meta">
          role: {{ row.role }} · <span class="mcp-target" :title="row.target">{{ row.target }}</span>
        </p>
      </section>
    </div>

    <p class="settings-note">
      Servers marked invalid could not be parsed from the config file; the backend
      skips them. Per-run connection outcomes are shown in the session status dialog.
    </p>
  </div>
</template>

<style scoped>
.mcp-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.settings-lead,
.settings-note {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.settings-note {
  font-size: 0.75rem;
}

.mcp-note {
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.mcp-error {
  margin: 0;
  font-size: 0.78rem;
  color: var(--danger);
  overflow-wrap: anywhere;
}

.mcp-server-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mcp-card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mcp-card-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.mcp-card-title {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
}

.mcp-badge {
  font-size: 0.7rem;
  padding: 1px 7px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--surface-raised);
  color: var(--text-secondary);
}

.mcp-badge-invalid {
  border-color: var(--danger);
  color: var(--danger);
}

.mcp-card-meta {
  margin: 0;
  font-size: 0.76rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.mcp-target {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.72rem;
  overflow-wrap: anywhere;
}
</style>
