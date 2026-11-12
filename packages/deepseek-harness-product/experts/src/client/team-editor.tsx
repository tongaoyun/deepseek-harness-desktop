import { useTeamLocale, localizedExperts } from './team-locale.ts';
import { deepEqualJson } from '@deepseek-ai/dsh-util-values';
import { randomUUID } from '@deepseek-ai/dsh-util-crypto';
import { LibraryEditorFooter, useLibraryUnloadGuard, useLibraryRemovalFocus } from './library-ui.tsx';
import React from 'react';
import { effectiveCoordinator, teamInputSchema, type TeamInput, type TeamSnapshot, } from '../team-contract.ts';
import { isExpertConflict, type ExpertSummary } from '../expert-contract.ts';
import { Button, Input } from './plugin-ui.ts';
import { SegmentedControl, focusWithoutRing } from '@deepseek-ai/dsh-client-ui-primitives';
import { CategorySelect } from './category-select.ts';
import { CONTENT_CATEGORIES, resolveContentCategory } from '@deepseek-harness/product/content-categories';
import { TeamDialog, TeamConfirm, Avatar, IconPlus, IconTrash, IconRefresh, IconSearch, } from './team-shared.tsx';
import { TeamDetails } from './team-ui.tsx';
import { filterTeamMemberCandidates, type TeamMemberPickerStatus } from './team-member-picker.ts';

const PICKER_ROW = 72

/** 只挂载可见行与当前焦点项，按专家标识保留候选按钮；当前候选移除时将焦点交还搜索。 */
function MemberPicker(props: {
    experts: readonly ExpertSummary[]
    locale: 'zh' | 'en'
    query: string
    source: 'all' | 'company' | 'custom'
    division: string
    status: TeamMemberPickerStatus
    enabled: readonly string[]
    taken: readonly { expertSlug: string }[]
    replacing: number
    tx(key: string): string
    onQuery(value: string): void
    onSource(value: 'all' | 'company' | 'custom'): void
    onDivision(value: string): void
    onStatus(value: TeamMemberPickerStatus): void
    onPick(expert: ExpertSummary): void
    close(): void
}) {
    const options = [{ value: '', label: props.tx("全部分类") }, ...CONTENT_CATEGORIES.map(category => ({ value: category.id, label: category[props.locale] }))]
    const matches = filterTeamMemberCandidates(props.experts, {
        source: props.source,
        division: props.division,
        status: props.status,
        enabled: props.enabled,
        taken: props.taken,
        replacing: props.replacing,
        query: props.query,
    })
    const scroller = React.useRef<HTMLDivElement>(null)
    const [top, setTop] = React.useState(0)
    const [height, setHeight] = React.useState(360)
    const [focused, setFocused] = React.useState<string | null>(null)
    const search = React.useRef<HTMLInputElement>(null)
    const candidateFocus = useLibraryRemovalFocus(() => search.current)
    React.useLayoutEffect(() => {
        const node = scroller.current
        if (node === null) return
        const measure = () => {
            setHeight(node.clientHeight)
            const maximum = Math.max(0, matches.length * PICKER_ROW - node.clientHeight)
            if (node.scrollTop > maximum) node.scrollTop = maximum
            setTop(node.scrollTop)
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        return () => observer.disconnect()
    }, [matches.length])
    React.useEffect(() => {
        scroller.current?.scrollTo({ top: 0 })
        setTop(0)
    }, [props.query, props.source, props.division, props.status])
    const start = Math.max(0, Math.floor(top / PICKER_ROW) - 4)
    const count = Math.ceil(height / PICKER_ROW) + 8
    const shown = new Set<number>()
    for (let index = start; index < Math.min(start + count, matches.length); index++) shown.add(index)
    const focusedIndex = focused === null ? -1 : matches.findIndex(expert => expert.slug === focused)
    if (focusedIndex >= 0) shown.add(focusedIndex)
    return (<TeamDialog title={props.tx("选择团队成员")} close={props.close} className="agt-picker">
      <div className="aag-filters aag-card-filters agt-picker-tools">
        <div className="aag-field aag-field-source">
          <CategorySelect id="agt-picker-source" value={props.source} label={props.tx("来源")} onChange={(value) => props.onSource(value === 'company' || value === 'custom' ? value : 'all')} options={[
            { value: 'all', label: props.tx("全部来源") },
            { value: 'company', label: props.tx("市场") },
            { value: 'custom', label: props.tx("我的") },
          ]}/>
        </div>
        <div className="aag-field aag-field-category">
          <CategorySelect id="agt-picker-category" value={props.division} label={props.tx("分类")} onChange={props.onDivision} options={options}/>
        </div>
        <div className="aag-field aag-field-status">
          <CategorySelect id="agt-picker-status" value={props.status} label={props.tx("状态")} onChange={(value) => props.onStatus(value === 'enabled' || value === 'disabled' ? value : '')} options={[
            { value: 'enabled', label: props.tx("已启用") },
            { value: '', label: props.tx("全部状态") },
            { value: 'disabled', label: props.tx("已停用") },
          ]}/>
        </div>
        <div className="aag-field aag-field-search">
          <div className="aag-search-wrap">
            <Input ref={search} className="aag-search" aria-label={props.tx("搜索团队成员")} data-modal-autofocus autoComplete="off" spellCheck={false} placeholder={props.tx("搜索专家、职责或领域")} icon={<IconSearch size={16}/>} value={props.query} onFocus={() => setFocused(null)} onChange={(event) => props.onQuery(event.target.value)}/>
          </div>
        </div>
      </div>
      <p className="agt-help agt-picker-note" role="note">{props.tx("停用的专家也可以加入专家团。不想单独使用专家、只想用专家团时，把状态改为「全部」或「已停用」。")}</p>
      <div className="agt-picker-list" ref={scroller} onScroll={(event) => setTop(event.currentTarget.scrollTop)}
        onFocusCapture={(event) => {
            const row = event.target.closest<HTMLElement>('[data-expert-slug]')
            setFocused(row?.dataset.expertSlug ?? null)
        }} onBlurCapture={(event) => {
            if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setFocused(null)
        }}>
        {matches.length === 0 ? <p className="agt-help">{props.tx("没有匹配的专家")}</p> : <div style={{ height: matches.length * PICKER_ROW, position: 'relative' }}>
          {[...shown].sort((left, right) => left - right).map((index) => {
            const expert = matches[index]!
            return <button ref={expert.slug === focused ? candidateFocus : undefined} type="button" className="agt-picker-row" key={expert.slug} data-expert-slug={expert.slug} style={{ position: 'absolute', top: index * PICKER_ROW, left: 0, right: 0, height: PICKER_ROW }} onClick={() => props.onPick(expert)}>
            <Avatar expert={expert} size={40}/>
            <span>
              <strong>{expert.name}</strong>
              <small>{resolveContentCategory(expert.division)[props.locale]} · {expert.description}</small>
            </span>
          </button>})}
        </div>}
      </div>
    </TeamDialog>)
}

const fresh = (tx: (key: string) => string): TeamInput => ({
    name: '',
    description: '',
    tags: [],
    goal: '',
    constraints: '',
    deliveryRequirements: tx("总体结论、主要依据、关键分歧、优先级行动清单及待确认事项。"),
    members: [],
    examples: [tx("请根据我提供的资料，给出有依据的结论与下一步建议。")],
    coordinatorMode: 'template',
    coordinatorTemplateId: 'general',
    coordinatorTemplateVersion: 1,
    coordinatorPrompt: '',
});
export function TeamEditor(props: {
    initial?: TeamInput;
    experts: readonly ExpertSummary[];
    enabled: boolean;
    enabledExperts: readonly string[];
    /** Cancellation for the mounted directory and its current Host. */
    signal?: AbortSignal;
    save(value: TeamInput, enabled: boolean, revision?: number): Promise<void>;
    close(): void;
    refresh(): Promise<TeamSnapshot>;
}) {
    const { locale, tx } = useTeamLocale();

    props = { ...props, experts: localizedExperts(props.experts, locale) };
    const [draft, setDraft] = React.useState<TeamInput>(() => structuredClone(props.initial ?? fresh(tx)));
    const [exampleKeys, setExampleKeys] = React.useState(() => draft.examples.map(() => randomUUID()));
    const memberButtons = React.useRef(new Map<string, HTMLButtonElement>());
    const memberFields = React.useRef(new Map<string, HTMLInputElement>());
    const selectedMember = React.useRef<string | null>(null);
    const movedMember = React.useRef<HTMLButtonElement | null>(null);
    React.useLayoutEffect(() => {
        const slug = selectedMember.current;
        selectedMember.current = null;
        const field = slug === null ? undefined : memberFields.current.get(slug);
        if (field) focusWithoutRing(field);
        const moved = movedMember.current;
        movedMember.current = null;
        if (moved && moved.ownerDocument.activeElement === moved.ownerDocument.body) focusWithoutRing(moved);
    }, [draft.members]);
    const addMember = React.useRef<HTMLButtonElement>(null);
    const exampleFields = React.useRef(new Map<string, HTMLTextAreaElement>());
    const addedExample = React.useRef<string | null>(null);
    React.useLayoutEffect(() => {
        const key = addedExample.current;
        addedExample.current = null;
        const field = key === null ? undefined : exampleFields.current.get(key);
        if (field) focusWithoutRing(field);
    }, [exampleKeys]);
    const [tagsInput, setTagsInput] = React.useState(() => draft.tags.join('，'));
    const tags = tagsInput.split(/[,，]/u).map(value => value.trim()).filter(Boolean);
    const original = React.useRef(draft);
    const form = React.useRef<HTMLFormElement>(null);
    const reviewArea = React.useRef<HTMLElement>(null);
    const reviewTrigger = React.useRef<HTMLButtonElement>(null);
    const operation = React.useRef(false);
    const [activity, setActivity] = React.useState<'save' | 'primary' | 'review' | null>(null);
    const busy = activity !== null;
    const dirty = !deepEqualJson({ ...draft, tags }, original.current);
    useLibraryUnloadGuard(dirty || busy);
    const [failure, setError] = React.useState<string | { field: string }>('');
    const labels: Record<string, string> = { name: tx("团队名称"), description: tx("一句话简介"), goal: tx("团队目标"), constraints: tx("通用约束（选填）"), deliveryRequirements: tx("交付要求"), members: tx("团队成员"), examples: tx("任务示例"), coordinatorPrompt: tx("主理人提示词") };
    const error = typeof failure === 'string' ? tx(failure) : tx("请检查字段：{0}。", [labels[failure.field] ?? failure.field]);
    const [needsReview, setNeedsReview] = React.useState(false);
    const [review, setReview] = React.useState<TeamSnapshot | null>(null);
    const [reviewedRevision, setReviewedRevision] = React.useState<number>();
    const [currentEnabled, setCurrentEnabled] = React.useState(props.enabled);
    const latestTeam = review?.teams.find((team) => team.id === draft.id);
    const [picker, setPicker] = React.useState<number | null>(null);
    const [query, setQuery] = React.useState('');
    const [pickerSource, setPickerSource] = React.useState<'all' | 'company' | 'custom'>('all');
    const [pickerDivision, setPickerDivision] = React.useState('');
    const [pickerStatus, setPickerStatus] = React.useState<TeamMemberPickerStatus>('enabled');
    const [confirm, setConfirm] = React.useState<'discard' | 'restore' | 'enable' | null>(null);
    const [preview, setPreview] = React.useState(false);
    const patch = (next: Partial<TeamInput>) => setDraft((value) => ({ ...value, ...next }));
    const moveMember = (index: number, direction: -1 | 1, trigger: HTMLButtonElement): void => {
        const next = index + direction;
        if (operation.current || next < 0 || next >= draft.members.length) return;
        movedMember.current = trigger.ownerDocument.activeElement === trigger ? trigger : null;
        const members = [...draft.members];
        [members[index], members[next]] = [members[next], members[index]];
        patch({ members });
    };
    const close = () => {
        if (operation.current)
            return;
        if (dirty)
            setConfirm('discard');
        else
            props.close();
    };
    const missing = props.experts.filter((e) => draft.members.some((m) => m.expertSlug === e.slug) &&
        !props.enabledExperts.includes(e.slug));
    const submit = async (enabled: boolean, confirmed = false) => {
        const signal = props.signal;
        if (operation.current || signal?.aborted || needsReview)
            return;
        if (form.current?.reportValidity() === false)
            return;
        if (tags.length > 3 || tags.some(tag => Array.from(tag).length > 16)) {
            setError("场景标签：最多 3 个，每个标签最多 16 个字符。");
            form.current?.querySelector<HTMLElement>('[name="tags"]')?.focus();
            return;
        }
        if (draft.coordinatorMode === 'custom' && (!draft.coordinatorPrompt.trim() || Array.from(draft.coordinatorPrompt).length > 12000)) {
            setError("主理人提示词：请填写 1～12000 个字符。");
            form.current?.querySelector<HTMLElement>('[name="coordinatorPrompt"]')?.focus();
            return;
        }
        const parsed = teamInputSchema.safeParse({ ...draft, tags });
        if (!parsed.success) {
            const key = String(parsed.error.issues[0]?.path[0] ?? 'members');
            setError({ field: key });
            form.current?.querySelector<HTMLElement>(`[name="${key}"]`)?.focus();
            return;
        }
        if (enabled && missing.length && !confirmed) {
            setConfirm('enable');
            return;
        }
        operation.current = true;
        setActivity(draft.id || enabled ? 'primary' : 'save');
        try {
            await props.save(parsed.data, enabled, reviewedRevision);
            if (!signal?.aborted) setError('');
        }
        catch (cause) {
            if (signal?.aborted) return;
            setError(cause instanceof Error ? cause.message : "保存失败，请重试。");
            if (isExpertConflict(cause)) {
                setNeedsReview(true);
                setReview(null);
                setConfirm(null);
            }
        }
        finally {
            operation.current = false;
            setActivity(null);
        }
    };
    const refreshReview = async () => {
        const signal = props.signal;
        if (operation.current || signal?.aborted) return;
        operation.current = true;
        setActivity('review');
        try {
            const next = await props.refresh();
            signal?.throwIfAborted();
            setReview(next);
        }
        catch (cause) {
            const trigger = reviewTrigger.current;
            if (trigger && reviewArea.current?.contains(trigger.ownerDocument.activeElement)) focusWithoutRing(trigger);
            setReview(null);
            if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "刷新失败。");
        }
        finally { operation.current = false; setActivity(null); }
    };
    const continueReview = (useLatest: boolean) => {
        if (operation.current || !review)
            return;
        const name = form.current?.querySelector<HTMLInputElement>('input[name="name"]');
        if (name && reviewArea.current?.contains(name.ownerDocument.activeElement)) focusWithoutRing(name);
        const latest = review.teams.find((team) => team.id === draft.id);
        if (latest) original.current = latest;
        if (useLatest && latest) {
            setDraft(structuredClone(latest));
            setExampleKeys(latest.examples.map(() => randomUUID()));
            setTagsInput(latest.tags.join('，'));
        }
        else if (draft.id && !latest) {
            const { id: _id, ...copy } = draft;
            setDraft(copy);
        }
        setCurrentEnabled(latest ? review.enabledTeams.includes(latest.id) : false);
        setReviewedRevision(review.revision);
        setNeedsReview(false);
        setReview(null);
        setError('');
    };
    const section = (title: string, children: React.ReactNode) => (<section className="agt-section" aria-label={title}>
      <h4>{title}</h4>
      <div className="agt-section-content">{children}</div>
    </section>);
    const field = (label: string, key: 'name' | 'description' | 'goal' | 'constraints' | 'deliveryRequirements', max: number, multi = false) => (<label className="aag-custom-field">
      <span>{label}{key !== 'constraints' && <small>{tx("必填")}</small>}</span>
      {multi ? (<Input.TextArea aria-label={label} name={key} value={draft[key]} maxLength={max} onChange={(e) => patch({ [key]: e.target.value })} rows={key === 'description' ? 2 : 3} required={key !== 'constraints'}/>) : (<Input aria-label={label} name={key} value={draft[key]} maxLength={max} required={key !== 'constraints'} onChange={(e) => patch({ [key]: e.target.value })}/>)}
    </label>);
    return (<TeamDialog title={props.initial?.id ? tx("编辑专家团") : tx("新建专家团")} close={close} className="agt-editor" footer={<LibraryEditorFooter editing={!!draft.id} busy={busy} saving={activity === 'save' || activity === 'primary' ? activity : false} blocked={needsReview} error={error} help={tx("保存配置不会发送任务。")} cancelLabel={tx("取消")} saveLabel={tx("保存")} primaryLabel={draft.id ? tx("保存修改") : tx("保存并启用")} pendingLabel={tx("正在保存…")} close={close} save={() => void submit(false)} primary={() => void submit(draft.id ? currentEnabled : true)}/>}>
      <form ref={form} onSubmit={(e) => {
            e.preventDefault();
            void submit(currentEnabled);
        }}>
        <div className="aag-custom-body agt-editor-scroll">
          <div className="agt-editor-fields">
            <fieldset disabled={busy} aria-busy={busy}>
              {section(tx("团队名片"), <>
                  {field(tx("团队名称"), 'name', 40)}
                  {field(tx("一句话简介"), 'description', 160, true)}
                  <label className="aag-custom-field">
                    <span>{tx("场景标签")}</span>
                    <Input aria-label={tx("场景标签")} name="tags" value={tagsInput} placeholder={tx("最多 3 个，用逗号分隔")} onChange={(e) => setTagsInput(e.target.value)}/>
                    <small>{tx("场景标签：最多 3 个，每个标签最多 16 个字符。")}</small>
                  </label>
                  <p className="agt-help">{tx("团队头像由成员头像自动组成。")}</p>
                  <Button onClick={() => setPreview(true)}>{tx("预览")}</Button>
                </>)}
              {section(tx("团队成员"), <>
                  <div className="agt-row">
                    <span>{draft.members.length} / 8</span>
                    <Button ref={addMember} disabled={draft.members.length >= 8} onClick={() => {
                setQuery('');
                setPickerSource('all');
                setPickerDivision('');
                setPickerStatus('enabled');
                setPicker(-1);
            }}>
                      <IconPlus />{tx("添加成员")}</Button>
                  </div>
                  {draft.members.map((m, i) => {
                const member = props.experts.find((e) => e.slug === m.expertSlug)
                const memberName = member?.name ?? tx("成员已失效")
                return (<div className="agt-edit-member" key={m.expertSlug}>
                      <div className="agt-row">
                        <Avatar expert={member}/>
                        <strong>{memberName}</strong>
                        <Button className="aag-icon-btn" title={tx("替换")} aria-label={tx("替换成员 {0}", [memberName])} onClick={() => {
                    setQuery('');
                    setPickerSource('all');
                    setPickerDivision('');
                    setPickerStatus('enabled');
                    setPicker(i);
                }}>
                          <IconRefresh />
                        </Button>
                        <Button ref={(node) => { if (node) memberButtons.current.set(m.expertSlug, node); else memberButtons.current.delete(m.expertSlug) }}
                          className="aag-icon-btn" danger title={tx("删除成员 {0}", [memberName])} aria-label={tx("删除成员 {0}", [memberName])} onClick={() => {
                    const adjacent = draft.members[i + 1] ?? draft.members[i - 1];
                    const target = adjacent ? memberButtons.current.get(adjacent.expertSlug) : addMember.current;
                    if (target) focusWithoutRing(target, { preventScroll: true });
                    patch({ members: draft.members.filter((_, n) => n !== i) });
                }}>
                          <IconTrash />
                        </Button>
                      </div>
                      <label className="aag-custom-field">
                        <span>{tx("职责摘要")}</span>
                        <Input ref={(node) => { if (node) memberFields.current.set(m.expertSlug, node); else memberFields.current.delete(m.expertSlug); }}
                          aria-label={tx("职责摘要")} value={m.duty} maxLength={100} onChange={(e) => patch({
                    members: draft.members.map((v, n) => n === i ? { ...v, duty: e.target.value } : v),
                })}/>
                      </label>
                      <details>
                        <summary>{tx("展开详细分工")}</summary>
                        <label className="aag-custom-field">
                          <span>{tx("详细分工")}</span>
                          <Input.TextArea aria-label={tx("详细分工")} value={m.instructions} maxLength={2000} rows={3} onChange={(e) => patch({
                    members: draft.members.map((v, n) => n === i
                        ? { ...v, instructions: e.target.value }
                        : v),
                })}/>
                        </label>
                        <div className="agt-row">
                          <Button className="agt-member-move" aria-disabled={i === 0}
                            onClick={(event) => moveMember(i, -1, event.currentTarget)}>{tx("上移")}</Button>
                          <Button className="agt-member-move" aria-disabled={i === draft.members.length - 1}
                            onClick={(event) => moveMember(i, 1, event.currentTarget)}>{tx("下移")}</Button>
                        </div>
                      </details>
                    </div>)})}
                </>)}
              {section(tx("协作与交付"), <>
                  {field(tx("团队目标"), 'goal', 2000, true)}
                  {field(tx("交付要求"), 'deliveryRequirements', 2000, true)}
                  {field(tx("通用约束（选填）"), 'constraints', 2000, true)}
                </>)}
              {section(tx("主理人提示词"), <>
                  <p className="agt-help">{tx("定义如何分配任务、处理分歧并汇总专家结果")}</p>
                  <div className="agt-row">
                    <SegmentedControl
                      id="agt-coordinator-mode"
                      label={tx("主理人提示词来源")}
                      value={draft.coordinatorMode}
                      options={[
                        { value: 'template', label: tx("团队模板") },
                        { value: 'custom', label: tx("自定义") },
                      ]}
                      onChange={(mode) => {
                        if (mode === 'template') patch({ coordinatorMode: 'template' })
                        else patch({
                          coordinatorMode: 'custom',
                          coordinatorPrompt: draft.coordinatorPrompt || effectiveCoordinator(draft, locale),
                        })
                      }}
                    />
                    <Button onClick={() => setConfirm('restore')}>
                      <IconRefresh />{tx("恢复团队模板")}</Button>
                  </div>
                  <Input.TextArea name="coordinatorPrompt" className="agt-prompt" aria-label={tx("主理人提示词正文")} readOnly={draft.coordinatorMode === 'template'} value={effectiveCoordinator(draft, locale)} onChange={(e) => patch({ coordinatorPrompt: e.target.value })}/>
                  <p className="agt-help">{tx("目标、约束、成员分工和交付要求会自动加入，无需重复填写。")}<span className="agt-count">
                      {Array.from(effectiveCoordinator(draft, locale)).length} / 12000
                    </span>
                  </p>
                </>)}
              {section(tx("任务示例"), <>
                  {draft.examples.map((example, i) => (<label key={exampleKeys[i]} className="aag-custom-field">
                      <span>{tx("任务示例")}{i + 1}</span>
                      <Input.TextArea ref={(node) => { if (node) exampleFields.current.set(exampleKeys[i], node); else exampleFields.current.delete(exampleKeys[i]) }}
                        aria-label={`${tx("任务示例")}${i + 1}`} value={example} maxLength={1000} rows={2} onChange={(e) => patch({
                    examples: draft.examples.map((v, n) => n === i ? e.target.value : v),
                })}/>
                      <Button disabled={draft.examples.length <= 1} onClick={() => {
                    const adjacent = exampleKeys[i + 1] ?? exampleKeys[i - 1];
                    const field = adjacent === undefined ? undefined : exampleFields.current.get(adjacent);
                    if (field) focusWithoutRing(field, { preventScroll: true });
                    setExampleKeys(keys => keys.filter((_, n) => n !== i));
                    patch({ examples: draft.examples.filter((_, n) => n !== i) });
                }}>{tx("移除此示例")}</Button>
                    </label>))}
                  <Button disabled={draft.examples.length >= 3} onClick={() => {
                    const key = randomUUID();
                    addedExample.current = key;
                    setExampleKeys(keys => [...keys, key]);
                    patch({ examples: [...draft.examples, ''] });
                }}>
                    <IconPlus />{tx("添加示例")}</Button>
                </>)}
            </fieldset>
            {needsReview && (<section ref={reviewArea} className="aag-custom-review">
                <Button ref={reviewTrigger} aria-disabled={busy} aria-busy={activity === 'review'} className={busy ? 'product-control-pending' : undefined}
                  onClick={() => void refreshReview()}>{tx("读取最新配置")}</Button>
                {review && (<>
                    <h4>{tx("最新内容")}</h4>
                    {latestTeam ? (<>
                        <p>
                          <strong>{latestTeam.name}</strong> ·{' '}
                          {review.enabledTeams.includes(latestTeam.id)
                        ? tx("已启用") : tx("已停用")}
                        </p>
                        <p>{latestTeam.description}</p>
                        <p>{tx("目标：")}{latestTeam.goal}</p>
                        <p>{tx("共同约束：")}{latestTeam.constraints || tx("未设置")}</p>
                        <p>{tx("交付要求：")}{latestTeam.deliveryRequirements}</p>
                        {latestTeam.members.map((member) => (<p key={member.expertSlug}>
                            {props.experts.find((expert) => expert.slug === member.expertSlug)?.name ?? tx("成员已失效")}
                            ：{member.duty}。{member.instructions}
                          </p>))}
                        <Input.TextArea aria-label={tx("最新主理人提示词")} readOnly value={effectiveCoordinator(latestTeam, locale)} rows={8}/>
                      </>) : (<p>{tx("该专家团已被删除，保留草稿将另存为新团队。")}</p>)}
                    <p>{tx("请核对差异，再选择保留草稿或采用最新配置。")}</p>
                    <div className="aag-custom-review-actions">
                      <Button aria-disabled={busy} className={busy ? 'product-control-pending' : undefined} onClick={() => continueReview(false)}>{tx("保留我的草稿")}</Button>
                      {review.teams.some((team) => team.id === draft.id) && (<Button aria-disabled={busy} className={busy ? 'product-control-pending' : undefined} onClick={() => continueReview(true)}>{tx("使用最新内容")}</Button>)}
                    </div>
                  </>)}
              </section>)}{' '}
          </div>
        </div>
      </form>
      {confirm && (<TeamConfirm busy={busy} error={error} cancelLabel={confirm === 'discard' ? tx("继续编辑") : tx("取消")} title={confirm === 'discard'
                ? tx("放弃未保存修改？") : confirm === 'restore'
                ? tx("恢复团队模板？") : tx("启用团队成员")} description={confirm === 'enable'
                ? tx("同时启用：{0}。停用团队时不会停用这些专家。", [missing.map((e) => e.name).join(locale === 'en' ? ', ' : '、')]) : confirm === 'restore'
                ? tx("只恢复主理人规则，不修改成员分工、目标或交付要求。") : tx("未保存的表单改动将丢弃。")} label={confirm === 'discard'
                ? tx("放弃修改") : confirm === 'restore'
                ? tx("确认恢复") : tx("启用团队及所需成员")} danger={confirm !== 'enable'} onCancel={() => setConfirm(null)} onConfirm={() => {
                const action = confirm;
                if (action !== 'enable')
                    setConfirm(null);
                if (action === 'discard')
                    props.close();
                else if (action === 'restore')
                    patch({ coordinatorMode: 'template', coordinatorPrompt: '' });
                else
                    void submit(true, true);
            }} />)}
      {picker !== null && (<MemberPicker experts={props.experts} locale={locale} query={query} source={pickerSource} division={pickerDivision} status={pickerStatus} enabled={props.enabledExperts} taken={draft.members} replacing={picker} tx={tx} onQuery={setQuery} onSource={setPickerSource} onDivision={setPickerDivision} onStatus={setPickerStatus} close={() => setPicker(null)} onPick={(expert) => {
            selectedMember.current = expert.slug;
            const member = {
                expertSlug: expert.slug,
                duty: expert.description.slice(0, 100) || tx("提供本专业分析"),
                instructions: expert.description || tx("从自身专业角度分析任务，给出结论、依据和建议。"),
            };
            patch({
                members: picker === -1
                    ? [...draft.members, member]
                    : draft.members.map((value, index) => index === picker ? { ...value, expertSlug: expert.slug } : value),
            });
            setPicker(null);
        }}/>)}
      {preview && (<TeamDetails team={{ ...draft, tags, id: draft.id ?? 'team-preview' }} experts={props.experts} close={() => setPreview(false)}/>)}
    </TeamDialog>);
}
