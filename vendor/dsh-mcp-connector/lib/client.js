/** Company distribution: one shared plugin page, embedded through public Settings slots. */
window.__ModuleLoader__.load({
  id: 'dsh-mcp-connector',
  factory: require => {
    const { createElement: h, useEffect, useRef } = require('react');
    const NS = 'mcp-connector';
    const inject = ['slots', 'locale', 'sessions', 'workspaces', 'conversation', 'uiWorkspace', 'layout'];
    function Page({ subscribeFrame, t }) {
      const frame = useRef(null);
      useEffect(() => subscribeFrame(frame.current), [subscribeFrame]);
      return h('iframe', {
        ref: frame, src: '/mcp-connector/ui/', title: t('title'),
        className: 'mcpConnectorEmbedded', 'data-mcp-connector-frame': true,
      });
    }
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: { title: 'MCP 连接器' }, en: { title: 'MCP Connectors' } }));
      ctx.effect(() => {
        const style = document.createElement('style');
        style.textContent = '.mcpConnectorEmbedded{display:block;width:100%;height:100%;min-height:480px;border:0;color-scheme:light dark}';
        document.head.append(style);
        return () => style.remove();
      }, 'mcp-connector: frame styles');
      const workspaceContext = () => {
        const workspaces = ctx.workspaces.list.getSnapshot();
        const current = ctx.sessions.list.getSnapshot().current;
        const selected = workspaces.items.find(item => item.sessionIds.includes(current));
        const id = selected?.workspaceId ?? workspaces.recentWorkspaceId;
        const workspace = workspaces.items.find(item => item.workspaceId === id);
        return workspace ? { workspaceId: id, title: workspace.title ?? id } : null;
      };
      const subscribeFrame = frame => {
        if (!frame) return () => {};
        let live = true;
        const post = value => { if (live) frame.contentWindow?.postMessage(value, location.origin); };
        const onMessage = event => {
          if (!live || event.origin !== location.origin || event.source !== frame.contentWindow) return;
          if (event.data?.type === 'mcp-connector:workspace-context-request') {
            post({ type: 'mcp-connector:workspace-context', workspace: workspaceContext(),
              workspaces: ctx.workspaces.list.getSnapshot().items.map(item => ({ workspaceId: item.workspaceId, title: item.title ?? item.workspaceId })) });
          }
          if (event.data?.type !== 'mcp-connector:start-session') return;
          const { requestId, prompt } = event.data;
          if (typeof requestId !== 'string' || requestId.length > 128 || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) return;
          const workspace = workspaceContext();
          const run = async () => {
            if (!workspace) throw new Error('请先选择工作区');
            const sessionId = await ctx.sessions.create({ workspaceId: workspace.workspaceId });
            if (!live) return;
            ctx.conversation.input.shell(sessionId).setDraft(prompt);
            ctx.sessions.open(sessionId);
            ctx.layout.selectPanel(null);
            post({ type: 'mcp-connector:start-session-result', requestId, ok: true });
          };
          void run().catch(error => post({ type: 'mcp-connector:start-session-result', requestId, ok: false, message: error.message }));
        };
        window.addEventListener('message', onMessage);
        return () => { live = false; window.removeEventListener('message', onMessage); };
      };
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'mcp-connector', order: 26, label: () => ctx.locale.bind(NS)('title'), locale: NS,
        inject: () => ({ subscribeFrame }),
      }, Page));
    }
    return { inject, apply };
  },
});
