<script setup lang="ts">
import { NButton } from 'naive-ui'
import AppDialog from './AppDialog.vue'

/**
 * `/permission` informational overlay: the named permission presets, the
 * approval model and where tool scopes live. It reports the fixed policy only —
 * it never invents current state and changes nothing (the selector stays in
 * Settings → Permissions, which the footer deep-links to).
 */

const emit = defineEmits<{
  close: []
  openSettings: []
}>()
</script>

<template>
  <AppDialog
    :show="true"
    size="md"
    title="Permissions"
    description="How privileged tool calls are approved in this workspace."
    @close="emit('close')"
  >
    <div class="permission-body">
      <section class="permission-section">
        <h3>Fail closed by default</h3>
        <p>
          Tools that can change files or run commands are privileged. When the brothers need one,
          the run pauses and you get an approval prompt; nothing privileged runs until you allow it.
        </p>
      </section>

      <section class="permission-section">
        <h3>Permission presets</h3>
        <p>
          Settings → Permissions offers four named presets — Read only, Always ask, Workspace write
          and Full access. Each one stores exactly one approval mode (readonly, ask, edits or
          allow-all), so switching a preset never invents a second enforcement layer. Full access
          is an explicit opt-in with a visible warning.
        </p>
      </section>

      <section class="permission-section">
        <h3>Approvals</h3>
        <p>
          A paused run shows a docked approval card above the composer with the action, its target
          and any command. Allow or Deny decides that request; the run resumes as soon as the
          backend accepts the decision. Repeating the exact same request after repeated denials is
          auto-denied instead of asking forever.
        </p>
      </section>

      <section class="permission-section">
        <h3>Tool scopes</h3>
        <p>
          Built-in tools are split between the Senior and the Junior. Plugins are shared by
          default (a plugin may scope one of its tools to a single role), and MCP servers can be
          scoped per role in their configuration. Role routes, plugins and MCP servers are
          configured in Settings — this dialog only explains the model.
        </p>
      </section>

      <section class="permission-section">
        <h3>Workspace safety</h3>
        <p>
          File writes and edits stay inside the selected workspace; sensitive paths are refused.
          Shell commands run with a bounded timeout, and stopping a run releases any pending
          approval as a denial.
        </p>
      </section>
    </div>

    <template #footer>
      <div class="permission-actions">
        <n-button attr-type="button" @click="emit('close')">Close</n-button>
        <n-button attr-type="button" type="primary" @click="emit('openSettings')">
          Open Permissions
        </n-button>
      </div>
    </template>
  </AppDialog>
</template>

<style scoped>
.permission-body {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

.permission-section h3 {
  margin: 0 0 0.25rem;
  font-size: 0.86rem;
  font-weight: 650;
  color: var(--text-primary);
}

.permission-section p {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.5;
  color: var(--text-secondary);
}

.permission-actions {
  display: flex;
  gap: 0.5rem;
}
</style>
