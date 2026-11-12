import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ExpertClientState } from './client-state.ts'
import { customCopyName } from './copy-name.ts'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { StateDot, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives';
import { localizedExperts, useTeamLocale } from './team-locale.ts';
import { useTeamDirectoryView } from './team-directory.ts';
import { LibraryCard, useLibraryRemovalFocus, useLibraryActionFocus } from './library-ui.tsx';
import { Button, Input } from './plugin-ui.ts';
import { CategorySelect } from './category-select.ts';
import React from 'react';
import { effectiveCoordinator, teamHasPinnedMembers, type ExpertTeam, type TeamInput, type TeamSnapshot, } from '../team-contract.ts';
import type { ExpertSummary } from '../expert-contract.ts';
import type { AgencyCatalogRemote, AgencyTeamsRemote } from './remote.ts';
import { TeamEditor } from './team-editor.tsx';
import { TeamDialog, TeamConfirm, TeamAvatars, MemberList, teamIssue, IconUsers, IconFileText, IconPlus,  IconBulb, IconCopy, IconSend, IconSearch, IconEye, IconTrash, } from './team-shared.tsx';
export { TEAM_CSS } from './team-style.ts';
export type TeamRemote = AgencyCatalogRemote & AgencyTeamsRemote;
/** Read a native Remote result without discarding its structured failure.
 * @param promise Native expert or team call.
 * @returns Successful value; otherwise throws the original native failure.
 */
export async function unwrap<T>(promise: Promise<RemoteResult<T>>): Promise<T> {
    const result = await promise;
    if (!result.ok)
        throw result.error;
    return result.value;
}
/** 团队详情原位更新；聚焦示例消失后返回标题，不滚动或抢占其他控件。 */
export function TeamDetails(props: {
    team: ExpertTeam;
    experts: readonly ExpertSummary[];
    busy?: boolean;
    selecting?: { example?: string };
    error?: string;
    refreshing?: boolean;
    refreshLabel?: string;
    onRefresh?(): void;
    close(): void;
    onSelect?(example?: string): void;
    onCopy?(): void;
    onEdit?(): void;
    onDelete?(): void;
    /** 父目录在详情移除前捕获其持有的焦点，提交后按当前页面恢复。 */
    captureCloseFocus?(): void;
}) {
    const { locale, tx } = useTeamLocale();

    props = { ...props, team: props.team, experts: localizedExperts(props.experts, locale) };
    const [prompt, setPrompt] = React.useState(false);
    const title = React.useRef<HTMLHeadingElement>(null);
    const captureCloseFocus = React.useRef(props.captureCloseFocus);
    captureCloseFocus.current = props.captureCloseFocus;
    React.useLayoutEffect(() => () => {
        const dialog = title.current?.closest('[role="dialog"]');
        if (dialog?.contains(dialog.ownerDocument.activeElement)) captureCloseFocus.current?.();
    }, []);
    const retry = useLibraryRemovalFocus(() => title.current);
    const [focusedExample, setFocusedExample] = React.useState<string | null>(null);
    const exampleFocus = useLibraryRemovalFocus(() => title.current);
    return (<TeamDialog title={tx("{0}详情", [props.team.name])} close={props.close} className="agt-detail"
      footer={props.error ? <><p className="aag-error" role="alert">{props.error}</p>
        {props.onRefresh && <Button ref={retry} aria-disabled={props.busy || props.refreshing || false} aria-busy={props.refreshing}
          className={props.busy || props.refreshing ? 'product-control-pending' : undefined}
          onClick={() => { if (!props.busy && !props.refreshing) props.onRefresh?.() }}>{props.refreshLabel ?? tx("刷新重试")}</Button>}</> : undefined}>
      <header className="agt-detail-head">
        <TeamAvatars team={props.team} experts={props.experts} large/>
        <div>
          <div className="agt-name-line">
            <h2 ref={title} tabIndex={-1}>{props.team.name}</h2>
            {props.team.tags.length > 0 && (<div className="agt-tags">
              {props.team.tags.map((tag) => (<span className="agt-tag" key={tag}>
                  {tag}
                </span>))}
            </div>)}
          </div>
          <p>
            {tx(props.team.company ? "市场专家团" : "我的专家团")} ·{' '}
            {props.team.members.length}{tx("位专家")}</p>
          <div className="agt-row">
            {props.onSelect && (<Button variant="primary" aria-disabled={props.busy} className={props.busy ? 'product-control-pending' : undefined}
              aria-busy={props.selecting !== undefined && props.selecting.example === undefined} onClick={() => { if (!props.busy) props.onSelect?.() }}>
                <IconSend size={16}/>{tx("召唤专家团")}</Button>)}
            {props.onCopy && (<Button aria-disabled={props.busy} className={props.busy ? 'product-control-pending' : undefined} onClick={() => { if (!props.busy) props.onCopy?.() }}>
                <IconCopy size={16}/>{tx("复制并自定义")}</Button>)}
            {props.onEdit && (<Button aria-disabled={props.busy} className={props.busy ? 'product-control-pending' : undefined} onClick={() => { if (!props.busy) props.onEdit?.() }}>{tx("编辑专家团")}</Button>)}
          </div>
        </div>
      </header>
      <p className="agt-description">{props.team.description}</p>
      <section>
        <h3>
          <IconBulb />{tx("团队帮你做")}</h3>
        <div className="agt-examples">
          {[...new Set(props.team.examples)].map((example) => (<Button key={example} ref={example === focusedExample ? exampleFocus : undefined}
            onFocus={() => setFocusedExample(example)} disabled={!props.onSelect} aria-disabled={props.busy || !props.onSelect}
            className={props.busy && props.onSelect ? 'product-control-pending' : undefined} aria-busy={props.selecting?.example === example}
            style={{ display: 'flex', width: '100%', height: 'auto', whiteSpace: 'normal', justifyContent: 'space-between' }} onClick={() => { if (!props.busy) props.onSelect?.(example) }}>
              <span>“{example}”</span>
              <IconSend size={16}/>
            </Button>))}
        </div>
        <p className="agt-help">{tx("选择后填入聊天草稿，由你确认发送。")}</p>
      </section>
      <section>
        <h3>
          <IconUsers />{tx("团队成员")}</h3>
        <MemberList team={props.team} experts={props.experts}/>
        <p className="agt-help">{tx("由当前会话协调，成员分别分析后统一汇总。")}</p>
        <details>
          <summary>{tx("查看成员完整分工")}</summary>
          {props.team.members.map((member) => (<p key={member.expertSlug}>
              <strong>
                {props.experts.find((e) => e.slug === member.expertSlug)
                ?.name ?? tx("成员失效")}
                ：
              </strong>
              {member.instructions}
            </p>))}
        </details>
      </section>
      <section>
        <h3>
          <IconFileText />{tx("你将获得")}</h3>
        <p>{props.team.deliveryRequirements}</p>
        <Button style={{ marginTop: 8 }} onClick={() => setPrompt(!prompt)} aria-expanded={prompt}>{tx("查看主理人提示词")}</Button>
        {prompt && (<Input.TextArea className="agt-read-prompt" readOnly aria-label={tx("主理人提示词正文")} value={effectiveCoordinator(props.team, locale)} style={{ height: 280, resize: 'none', overflow: 'auto' }}/>)}
      </section>
      {props.onDelete && (<Button danger aria-disabled={props.busy} className={props.busy ? 'product-control-pending' : undefined}
        style={{ margin: '0 16px 16px', alignSelf: 'flex-start' }} onClick={() => { if (!props.busy) props.onDelete?.() }}>{tx("删除专家团")}</Button>)}
    </TeamDialog>);
}
export function TeamsPanel(props: {
    cache: ExpertClientState;
    remote: TeamRemote;
    startCreation?: (() => void) | undefined;
    source?: 'company' | 'custom';
    active?: boolean;
    onSaved?(): void;
    prepareSelect?(): (team: ExpertTeam, example?: string) => boolean | Promise<boolean>;
    onSelect?(team: ExpertTeam, example?: string): boolean | Promise<boolean>;
    headerLinks?: React.ReactNode;
    sharedHeader?: boolean;
    title?: string;
}) {
    const { locale, tx, error, setError, directory, snapshot, experts } = useTeamDirectoryView({ cache: props.cache, remote: props.remote, fallback: "加载失败。" });
    const [query, setQuery] = React.useState('');
    const searchField = React.useRef<HTMLDivElement>(null);
    const retry = useLibraryRemovalFocus(() => searchField.current?.querySelector('input'));
    const [status, setStatus] = React.useState('');
    const [notice, setNotice] = React.useState('');
    const operation = React.useRef<AbortSignal | null>(null);
    const [pending, setPending] = React.useState<{ signal: AbortSignal; teamId: string; action: 'enable' | 'delete' | 'select'; example?: string } | null>(null);
    const busy = pending !== null && !pending.signal.aborted;
    const directoryArea = React.useRef<HTMLElement>(null);
    const preserveActionFocus = useLibraryActionFocus(busy, props.active === false ? '' : props.source ?? '',
        directoryArea, () => searchField.current?.querySelector('input'));
    const preserveCloseFocus = useLibraryActionFocus(false, props.active === false ? '' : props.source ?? '',
        directoryArea, () => searchField.current?.querySelector('input'));
    const [detailsId, setDetailsId] = React.useState<string | null>(null);
    const details = snapshot?.teams.find(team => team.id === detailsId) ?? null;
    const [editor, setEditor] = React.useState<{
        value?: TeamInput;
        enabled: boolean;
        revision: number;
    } | null>(null);
    const closeEditor = () => { preserveCloseFocus(); setEditor(null); };
    const [confirm, setConfirm] = React.useState<{
        team: ExpertTeam;
        action: 'enable' | 'delete' | 'select';
        example?: string;
        snapshot: TeamSnapshot;
    } | null>(null);
    React.useEffect(() => {
        setPending(null);
        setError('');
        setNotice('');
        setDetailsId(null);
        setConfirm(null);
        setEditor(null);
        // The shared directory hook owns subscriptions and request cancellation.
    }, [props.remote, props.cache]);
    React.useEffect(() => {
        if (detailsId !== null && !details) setDetailsId(null);
        if (!snapshot) {
            setConfirm(null);
        }
    }, [snapshot, detailsId, details]);
    React.useEffect(() => {
        if (!props.active) return;
        let live = true;
        const signal = directory.getSignal();
        if (!signal || signal.aborted) return;
        void props.cache.catalog.refresh(props.source === 'company').then(() => {
            if (live && !signal.aborted) return directory.refresh();
        }).catch(cause => { if (live && !signal.aborted) setError(cause instanceof Error ? cause.message : "加载失败。"); });
        return () => { live = false; };
    }, [props.active, props.source, props.remote, props.cache, directory.refresh, directory.getSignal]);
    const accept = async (value: TeamSnapshot, started: TeamSnapshot | null, signal: AbortSignal) => {
        const next = await props.cache.teams.acceptMutation(value, started);
        signal.throwIfAborted();
        props.cache.catalog.adoptRevision(next.revision, next.enabledExperts);
    };
    const change = async (team: ExpertTeam, action: 'enable' | 'delete' | 'select', example?: string, reviewed?: TeamSnapshot) => {
        const signal = directory.getSignal();
        if ((operation.current && !operation.current.aborted) || !snapshot || !signal || signal.aborted)
            return;
        if (reviewed && (reviewed.revision !== snapshot.revision
            || !deepEqualJson(team, snapshot.teams.find(value => value.id === team.id) ?? null)
            || reviewed.enabledTeams.includes(team.id) !== snapshot.enabledTeams.includes(team.id)
            || team.members.some(member => reviewed.enabledExperts.includes(member.expertSlug) !== snapshot.enabledExperts.includes(member.expertSlug)))) {
            setConfirm(null);
            setError("配置已更新，请读取最新内容后重试。");
            return;
        }
        const revision = (reviewed ?? snapshot).revision;
        const enabling = action !== 'delete' &&
            (action === 'select' || !snapshot.enabledTeams.includes(team.id));
        if (enabling && !teamHasPinnedMembers(team)) {
            setError("团队成员需要重新选择并保存。");
            return;
        }
        const missing = team.members.filter((m) => !snapshot.enabledExperts.includes(m.expertSlug));
        if (!reviewed && (action === 'delete' || (enabling && missing.length))) {
            setConfirm({ team, action, example, snapshot });
            setError('');
            return;
        }
        const started = props.cache.teams.getSnapshot();
        if (action === 'enable') preserveActionFocus();
        operation.current = signal;
        setPending({ signal, teamId: team.id, action, example });
        try {
            const insert = action === 'select' ? props.prepareSelect?.() ?? props.onSelect : undefined;
            if (action === 'delete') {
                const next = await unwrap(props.remote.deleteTeam(team.id, revision, signal));
                if (signal.aborted) return;
                preserveActionFocus();
                setConfirm(null);
                setDetailsId(null);
                setNotice(tx("专家团已删除，成员与历史会话保留。"));
                await accept(next, started, signal);
            }
            else {
                if (action === 'enable' ||
                    !snapshot.enabledTeams.includes(team.id) ||
                    missing.length) {
                    const next = await unwrap(props.remote.setTeamEnabled(team.id, enabling, revision, signal));
                    if (signal.aborted) return;
                    setConfirm(null);
                    await accept(next, started, signal);
                }
                if (signal.aborted)
                    return;
                if (action === 'select') {
                    const current = props.cache.teams.getSnapshot();
                    const selected = current?.teams.find(value => value.id === team.id);
                    if (!current || !selected || !current.enabledTeams.includes(team.id)
                        || teamIssue(selected, props.cache.catalog.getSnapshot().experts, current.enabledExperts)) {
                        throw new Error(tx("团队已停用或成员失效，请修复后再发送。"));
                    }
                    const inserted = await insert?.(selected, example);
                    if (signal.aborted) return;
                    if (!inserted) {
                        setError("团队已启用，但无法写入当前聊天草稿。请关闭设置后，在聊天的专家团入口选择。");
                        return;
                    }
                    setDetailsId(null);
                    setNotice("专家团已加入草稿，确认需求后发送。");
                }
            }
            setError('');
            setConfirm(null);
        }
        catch (cause) {
            if (!signal.aborted) setError(cause instanceof Error ? cause.message : "操作失败。");
        }
        finally {
            if (operation.current === signal) operation.current = null;
            if (!signal.aborted) setPending(null);
        }
    };
    const copy = (team: ExpertTeam) => {
        setDetailsId(null);
        const { id: _id, company: _company, ...value } = team;
        setEditor({
            value: {
                ...structuredClone(value),
                members: value.members.map(member => ({ ...member,
                    expertSlug: experts.find(expert => expert.slug === member.expertSlug)?.packageSlug ?? member.expertSlug,
                })),
                name: customCopyName(team.name, tx("{0}副本", ['']), snapshot!.teams.map(team => team.name)),
            },
            enabled: false,
            revision: snapshot!.revision,
        });
    };
    const filtered = snapshot?.teams.filter((team) => Boolean('company' in team && team.company) === (props.source === 'company') && (!status ||
            snapshot.enabledTeams.includes(team.id) === (status === 'enabled')) &&
        `${team.name} ${team.description} ${team.members.map((m) => experts.find((e) => e.slug === m.expertSlug)?.name ?? '').join(' ')}`
            .toLowerCase()
            .includes(query.toLowerCase())) ?? [];
    const edit = (team: ExpertTeam) => setEditor({
        value: team,
        enabled: snapshot!.enabledTeams.includes(team.id),
        revision: snapshot!.revision,
    });
    const panel = (<section ref={directoryArea} className="aag-section aag-team-library" id="aag-team-source-panel">
      {!props.sharedHeader && <div className="aag-toolbar">
        <div className="aag-title-row">
          {!props.sharedHeader && <h2 className="aag-title">{props.title ?? tx("专家团")}</h2>}
          {!props.sharedHeader && props.headerLinks}
          <span className="aag-header-stat">
            <strong>{snapshot?.teams.length ?? '—'}</strong>{tx("个专家团")}</span>
          <span className="aag-header-stat">{tx("已启用")}<strong>{snapshot?.enabledTeams.length ?? '—'}</strong>
          </span>
        </div>
      </div>}

      <div className="aag-filters aag-card-filters">
        <div className="aag-field aag-field-status">
          <CategorySelect id="aag-team-status" label={tx("状态")} value={status} onChange={setStatus} options={[
            { value: '', label: tx("全部状态") },
            { value: 'enabled', label: tx("已启用") },
            { value: 'disabled', label: tx("已停用") },
        ]}/>
        </div>
        <div className="aag-field aag-field-search">
          <div ref={searchField} className="aag-search-wrap">
            <Input id="aag-team-search" className="aag-search" aria-label={tx("搜索专家团")} placeholder={tx("搜索团队、用途或成员")} value={query} autoComplete="off" spellCheck={false} icon={<IconSearch size={16}/>} onChange={(event) => setQuery(event.target.value)}/>
          </div>
        </div>
        {props.startCreation && <div className="aag-filter-actions">
          <Button variant="primary" size="sm" icon={<IconPlus size={16} aria-hidden="true" />} onClick={props.startCreation}>{tx('通过对话创建专家团')}</Button>
        </div>}
      </div>
      {error && !details && !confirm && (<div className="aag-error" role="alert">
          {error}
          <Button ref={retry} aria-disabled={directory.refreshing} aria-busy={directory.refreshing}
            className={directory.refreshing ? 'product-control-pending' : undefined} onClick={() => void directory.refresh()}>{tx("刷新重试")}</Button>
        </div>)}
      {notice && (<p role="status" className="aag-custom-notice">
          {tx(notice)}
        </p>)}
      {!snapshot && !error && <div role="status" aria-label={tx("正在加载专家团…")} className="product-capability-pending"><StateDot state="ongoing" size={14} className="product-read-indicator" /></div>}
      <div className="aag-expert-grid aag-team-grid">
        {filtered.map((team) => {
            const issue = teamIssue(team, experts, snapshot!.enabledExperts);
            const enabled = snapshot!.enabledTeams.includes(team.id);
            return (<LibraryCard key={team.id} testId="team-card" name={team.name} avatar={<div className="aag-team-avatar">
                  <TeamAvatars team={team} experts={experts}/>
                </div>} metadata={tx("{0} 位专家", [team.members.length])} description={(enabled || !teamHasPinnedMembers(team)) && issue
                    ? `${team.description} ${tx(issue)}`
                    : team.description} enabled={enabled} pending={busy} enabledLabel={tx("已启用")} disabledLabel={tx("已停用")} toggle={() => void change(team, 'enable')} moreItems={[
                    ...(team.company ? [{ id: 'copy', label: tx("复制并自定义"), shortLabel: tx("复制"), pending: busy, onSelect: () => copy(team) }] : [
                      { id: 'edit', label: tx("编辑专家团"), shortLabel: tx("编辑"), icon: <IconCopy size={16} />, pending: busy, onSelect: () => edit(team) },
                      ...('dshDesktop' in globalThis ? [{ id: 'submit', label: tx("提交发布"), shortLabel: tx("提交"), pending: busy, onSelect: () => {
                        document.dispatchEvent(new CustomEvent('dsh:company-content-submit', { cancelable: true, detail: {
                          name: team.name, prepare: async (signal: AbortSignal) => {
                            signal.throwIfAborted();
                            const value = await unwrap(props.remote.exportTeam(team.id, snapshot!.revision, signal));
                            signal.throwIfAborted(); return value;
                          },
                        } }));
                      } }] : []),
                      { id: 'delete', label: tx("删除专家团"), shortLabel: tx("删除"), icon: <IconTrash size={16} />, danger: true, pending: busy, onSelect: () => void change(team, 'delete') },
                    ]),
                ]} actions={<>
                  <button type="button" className="aag-card-action" title={tx("查看详情")} aria-label={tx("查看详情")} aria-haspopup="dialog" onClick={() => setDetailsId(team.id)}>
                    <IconEye size={18}/><span className="aag-card-action-text">{tx("详情")}</span></button>
                </>}/>);
        })}
      </div>{' '}
      {snapshot && !filtered.length && (<div className="product-capability-empty">
          <IconUsers size={40}/>
          <h3>{tx("没有找到专家团")}</h3>
          <p>{tx(props.source === 'company' ? "审核发布后的专家团会展示在这里。" : "换个关键词，或创建自己的专家团。")}</p>
          {(query || status) && <Button onClick={() => {
                setQuery('');
                setStatus('');
                const search = searchField.current?.querySelector('input');
                if (search) focusWithoutRing(search);
            }}>{tx("清除筛选")}</Button>}
        </div>)}
      {details && (<TeamDetails team={details} experts={experts} busy={busy} error={confirm ? undefined : error} captureCloseFocus={preserveCloseFocus}
        refreshing={directory.refreshing} onRefresh={() => void directory.refresh()}
        selecting={busy && pending.teamId === details.id && pending.action === 'select' ? { example: pending.example } : undefined}
        close={() => { if (!operation.current || operation.current.aborted) setDetailsId(null) }}
        onCopy={() => copy(details)} onSelect={(example) => void change(details, 'select', example)} onEdit={details.company ? undefined : () => {
                    setEditor({
                        value: details,
                        enabled: snapshot!.enabledTeams.includes(details.id),
                        revision: snapshot!.revision,
                    });
                    setDetailsId(null);
                }} onDelete={details.company ? undefined : () => void change(details, 'delete')}/>)}
      {editor && (<TeamEditor initial={editor.value} experts={experts} enabled={editor.enabled} enabledExperts={snapshot?.enabledExperts ?? []} signal={directory.getSignal()} close={closeEditor} refresh={async () => {
                const signal = directory.getSignal();
                if (!signal) throw new DOMException('Expert panel is unavailable', 'AbortError');
                signal.throwIfAborted();
                await props.cache.teams.refresh();
                signal.throwIfAborted();
                await props.cache.catalog.refresh();
                signal.throwIfAborted();
                const latest = props.cache.teams.getSnapshot();
                if (!latest) throw new DOMException('Expert teams disconnected', 'AbortError');
                return latest;
            }} save={async (value, enabled, revision) => {
                const signal = directory.getSignal();
                if (!signal) return;
                signal.throwIfAborted();
                const started = props.cache.teams.getSnapshot();
                const next = await unwrap(props.remote.saveTeam(value, enabled, revision ?? editor.revision, signal));
                signal.throwIfAborted();
                try {
                    await accept(next, started, signal);
                } catch (cause) {
                    if (!signal.aborted) setError(cause instanceof Error ? cause.message : "加载失败。");
                }
                if (signal.aborted) return;
                closeEditor();
                setNotice(tx("专家团配置已保存。"));
                props.onSaved?.();
            }}/>)}
      {confirm && (<TeamConfirm title={confirm.action === 'delete' ? tx("删除专家团？") : tx("启用团队成员")} description={confirm.action === 'delete'
                ? tx("删除“{0}”的配置，保留成员专家和历史会话。", [confirm.team.name]) : tx("同时启用：{0}。停用团队时不会停用成员。", [confirm.team.members
                    .filter((m) => !snapshot!.enabledExperts.includes(m.expertSlug))
                    .map((m) => experts.find((e) => e.slug === m.expertSlug)?.name ?? tx("失效成员"))
                    .join(locale === 'en' ? ', ' : '、')])} label={confirm.action === 'delete' ? tx("确认删除") : tx("启用团队及所需成员")} danger={confirm.action === 'delete'} busy={busy} error={error}
        onCancel={() => { if (!operation.current || operation.current.aborted) setConfirm(null) }} onConfirm={() => {
                const current = confirm;
                void change(current.team, current.action, current.example, current.snapshot);
            }} />)}
    </section>);
    return panel;
}
