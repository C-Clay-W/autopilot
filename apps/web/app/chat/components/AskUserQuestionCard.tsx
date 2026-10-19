/**
 * 结构化澄清问题卡：在安全 Presentation 问题上完成单选、补充、切题和提交，不读取 Tool 原始数据。
 */
"use client";

import { useState, type KeyboardEvent } from "react";
import type { UserQuestionItem } from "@autopilot-agent/presentation";

export interface UserQuestionAnswerDraft {
  id: string;
  selected: string[];
  custom?: string;
}

interface AskUserQuestionCardProps {
  question: UserQuestionItem;
  disabled?: boolean;
  onSubmit: (answers: UserQuestionAnswerDraft[]) => Promise<void>;
  onCancel: () => void;
}

interface QuestionDraft {
  selected?: string;
  custom: string;
}

/** 创建指定问题的空白草稿，避免切换问题时混用答案。 */
function createQuestionDraft(): QuestionDraft {
  return { custom: "" };
}

/** 将当前草稿转换为 Route 所需的互斥单选或补充答案。 */
function toAnswerDraft(questionId: string, draft: QuestionDraft): UserQuestionAnswerDraft {
  const custom = draft.custom.trim();
  return { id: questionId, selected: draft.selected ? [draft.selected] : [], ...(custom ? { custom } : {}) };
}

/** 判断草稿是否已经为当前题提供可提交的单选或补充内容。 */
function hasAnswer(draft: QuestionDraft | undefined): boolean {
  return Boolean(draft?.selected || draft?.custom.trim());
}

/** 渲染可持久化回答前的本地草稿卡；第一个模型选项固定为推荐项。 */
export default function AskUserQuestionCard({ question, disabled = false, onSubmit, onCancel }: AskUserQuestionCardProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const currentQuestion = question.questions[activeIndex];
  const currentDraft = currentQuestion ? drafts[currentQuestion.id] ?? createQuestionDraft() : createQuestionDraft();
  const isBusy = disabled || submitting;

  /** 保存当前题局部草稿，其他题草稿保持原样以支持前后切换。 */
  function updateCurrentDraft(nextDraft: QuestionDraft): void {
    if (!currentQuestion) return;
    setDrafts(function saveQuestionDraft(current) {
      return { ...current, [currentQuestion.id]: nextDraft };
    });
    setError("");
  }

  /** 选中一个模型选项，并清除与其互斥的 Other 内容。 */
  function selectOption(label: string): void {
    updateCurrentDraft({ selected: label, custom: "" });
  }

  /** 输入 Other 内容时清除模型选项，保证提交 DTO 始终符合单选互斥契约。 */
  function updateCustom(custom: string): void {
    updateCurrentDraft({ custom, ...(custom.trim() ? {} : { selected: currentDraft.selected }) });
  }

  /** 使用方向键在当前问题的互斥选项之间移动，并同步 roving focus。 */
  function handleOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, optionIndex: number): void {
    if (!currentQuestion || !["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) return;
    event.preventDefault();
    const offset = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (optionIndex + offset + currentQuestion.options.length) % currentQuestion.options.length;
    selectOption(currentQuestion.options[nextIndex].label);
    document.getElementById(`user-question-option-${question.requestId}-${currentQuestion.id}-${nextIndex}`)?.focus();
  }

  /** 按 Tabs 约定切换题目，并把焦点移动到当前激活题签。 */
  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (!question.questions.length || !["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const lastIndex = question.questions.length - 1;
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? lastIndex : (index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + question.questions.length) % question.questions.length;
    setActiveIndex(nextIndex);
    setError("");
    document.getElementById(`user-question-tab-${question.requestId}-${question.questions[nextIndex].id}`)?.focus();
  }

  /** 提交全部题目的草稿；本地先校验完整性，服务端仍是唯一持久化校验方。 */
  async function submitAnswers(): Promise<void> {
    const missingQuestion = question.questions.find(function findMissingQuestion(item) {
      return !hasAnswer(drafts[item.id]);
    });
    if (missingQuestion) {
      setActiveIndex(question.questions.findIndex(function findMissingIndex(item) { return item.id === missingQuestion.id; }));
      setError(`请先回答“${missingQuestion.header}”`);
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onSubmit(question.questions.map(function createAnswer(item) { return toAnswerDraft(item.id, drafts[item.id]); }));
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "提交失败，请重试");
      setSubmitting(false);
    }
  }

  if (!currentQuestion) return null;
  const panelId = `user-question-panel-${question.requestId}-${currentQuestion.id}`;

  return (
    <section id={`user-question-${question.requestId}`} className="mt-3 border-2 border-ink bg-card p-4 text-xs shadow-[4px_4px_0_var(--ink)]" aria-labelledby={`user-question-title-${question.requestId}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p id={`user-question-title-${question.requestId}`} className="font-bold">需要你确认</p>
          <p className="mt-1 text-muted">回答后将从当前任务继续执行。</p>
        </div>
        <span className="border border-ink px-2 py-1 font-semibold text-accent">{activeIndex + 1} / {question.questions.length}</span>
      </div>

      {question.questions.length > 1 && (
        <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="澄清问题">
          {question.questions.map(function renderQuestionTab(item, index) {
            const selected = index === activeIndex;
            return <button key={item.id} id={`user-question-tab-${question.requestId}-${item.id}`} type="button" role="tab" tabIndex={selected ? 0 : -1} aria-selected={selected} aria-controls={`user-question-panel-${question.requestId}-${item.id}`} disabled={isBusy} onClick={function selectQuestionTab() { setActiveIndex(index); setError(""); }} onKeyDown={function moveQuestionTab(event) { handleTabKeyDown(event, index); }} className={`border-2 border-ink px-2 py-1 font-semibold transition-colors disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-on-dark ${selected ? "bg-accent text-ink-on-dark" : "bg-card hover:bg-ink hover:text-ink-on-dark"}`}>{index + 1}. {item.header}</button>;
          })}
        </div>
      )}

      <div id={panelId} role="tabpanel" aria-labelledby={question.questions.length > 1 ? `user-question-tab-${question.requestId}-${currentQuestion.id}` : `user-question-heading-${question.requestId}-${currentQuestion.id}`} className="mt-4">
        <p id={`user-question-heading-${question.requestId}-${currentQuestion.id}`} className="text-[10px] font-semibold tracking-widest text-accent">{currentQuestion.header}</p>
        <p className="mt-2 text-sm font-semibold leading-6">{currentQuestion.question}</p>
        <div className="mt-3 space-y-2" role="radiogroup" aria-label={currentQuestion.question}>
          {currentQuestion.options.map(function renderOption(option, optionIndex) {
            const selected = currentDraft.selected === option.label;
            return (
              <button key={option.label} id={`user-question-option-${question.requestId}-${currentQuestion.id}-${optionIndex}`} type="button" role="radio" tabIndex={selected || (!currentDraft.selected && optionIndex === 0) ? 0 : -1} aria-checked={selected} disabled={isBusy} onClick={function chooseOption() { selectOption(option.label); }} onKeyDown={function moveOption(event) { handleOptionKeyDown(event, optionIndex); }} className={`group flex w-full items-start gap-3 border-2 border-ink px-3 py-3 text-left transition-[transform,box-shadow,background-color] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-on-dark ${selected ? "bg-accent text-ink-on-dark shadow-[3px_3px_0_var(--ink)]" : "bg-card hover:-translate-y-0.5 hover:bg-ink/10 hover:shadow-[3px_3px_0_var(--ink)]"}`}>
                <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border-2 border-ink ${selected ? "bg-ink text-ink-on-dark" : "bg-card group-hover:bg-accent"}`} aria-hidden="true">{selected ? "•" : ""}</span>
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{option.label}{optionIndex === 0 ? "（推荐）" : ""}</span>
                  <span className={`mt-1 block leading-5 ${selected ? "text-ink-on-dark/90" : "text-muted"}`}>{option.description}</span>
                </span>
              </button>
            );
          })}
        </div>
        <label className="mt-4 block" htmlFor={`user-question-other-${question.requestId}-${currentQuestion.id}`}>
          <span className="font-semibold">其他 / 补充说明</span>
          <textarea id={`user-question-other-${question.requestId}-${currentQuestion.id}`} value={currentDraft.custom} disabled={isBusy} onChange={function changeCustom(event) { updateCustom(event.target.value); }} maxLength={2000} rows={3} placeholder="填写后将替代上方选项" className="mt-2 w-full resize-y border-2 border-ink bg-card px-3 py-2 leading-5 outline-none focus:border-accent disabled:cursor-not-allowed disabled:bg-muted" />
        </label>
      </div>

      {error && <p className="mt-3 border-l-4 border-error bg-error/10 px-3 py-2 text-error" role="alert">{error}</p>}
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <button type="button" onClick={onCancel} disabled={isBusy} className="border-2 border-ink bg-card px-3 py-2 font-semibold hover:bg-ink hover:text-ink-on-dark disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-on-dark">取消当前任务</button>
        <div className="flex gap-2">
          <button type="button" disabled={isBusy || activeIndex === 0} onClick={function showPreviousQuestion() { setActiveIndex(activeIndex - 1); setError(""); }} className="border-2 border-ink bg-card px-3 py-2 font-semibold hover:bg-ink hover:text-ink-on-dark disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-on-dark">上一题</button>
          <button type="button" disabled={isBusy || activeIndex === question.questions.length - 1} onClick={function showNextQuestion() { setActiveIndex(activeIndex + 1); setError(""); }} className="border-2 border-ink bg-card px-3 py-2 font-semibold hover:bg-ink hover:text-ink-on-dark disabled:cursor-not-allowed disabled:bg-muted disabled:text-ink-on-dark">下一题</button>
          <button type="button" disabled={isBusy} onClick={function submitQuestionAnswers() { void submitAnswers(); }} className="border-2 border-ink bg-accent px-3 py-2 font-semibold text-ink-on-dark hover:bg-ink disabled:cursor-not-allowed disabled:bg-muted">{submitting ? "提交中…" : "提交并继续"}</button>
        </div>
      </div>
    </section>
  );
}
