package api

import (
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"myaiui2/internal/logging"
	"myaiui2/internal/repository"
)

// duplicateTitleSuffix 复制话题时追加的后缀，用于和原话题区分。
const duplicateTitleSuffix = "（副本）"

// DuplicateTopic 把话题的当前活动分支复制成一个新话题，并沿用原话题的助手。
// 只复制活动路径：分支树里的兄弟变体不进入副本，否则副本会出现多条互斥的历史。
// 所有“生成中”状态会改写为 cancelled，避免副本里留下永远不会继续的占位回答。
func (a *AppAPI) DuplicateTopic(topicID string) (TopicDTO, error) {
	if err := a.ready(); err != nil {
		return TopicDTO{}, err
	}
	id := strings.TrimSpace(topicID)
	if err := validateUUID("话题 ID", id); err != nil {
		return TopicDTO{}, err
	}
	source, err := a.topics.Get(id)
	if err != nil {
		return TopicDTO{}, wrapRepoErr("读取话题失败", "话题不存在", err)
	}
	_, path, err := a.topicAndActivePath(source.ID)
	if err != nil {
		return TopicDTO{}, wrapRepoErr("读取话题分支失败", "", err)
	}

	now := nowMs()
	topic := repository.Topic{
		ID:          uuid.NewString(),
		AssistantID: source.AssistantID,
		Title:       duplicateTopicTitle(source.Title),
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := a.topics.Create(topic); err != nil {
		return TopicDTO{}, wrapRepoErr("创建话题副本失败", "", err)
	}
	// 任一步失败都删掉刚建的话题（消息级联删除）：宁可让用户重试，也不留下半份副本。
	rollback := func() {
		if delErr := a.topics.Delete(topic.ID); delErr != nil {
			logging.Errorf("回滚话题副本失败: %v", delErr)
		}
	}

	lastID := ""
	for index, item := range path {
		message := repository.Message{
			ID:            uuid.NewString(),
			TopicID:       topic.ID,
			Role:          item.Role,
			Status:        clonedTopicMessageStatus(item.Status),
			PartsJSON:     item.PartsJSON,
			ProviderID:    item.ProviderID,
			ModelRemoteID: item.ModelRemoteID,
			ParentID:      lastID,
			SortOrder:     index + 1,
			CreatedAt:     now,
			UpdatedAt:     now,
		}
		if err := a.messages.Create(message); err != nil {
			rollback()
			return TopicDTO{}, wrapRepoErr("复制消息失败", "", err)
		}
		lastID = message.ID
	}
	// 空话题没有活动节点可设置，保持 active_node_id 为空即可。
	if lastID != "" {
		if err := a.topics.SetActiveNode(topic.ID, lastID, now); err != nil {
			rollback()
			return TopicDTO{}, wrapRepoErr("切换活动分支失败", "", err)
		}
		topic.ActiveNodeID = lastID
	}
	// 副本只包含一条线性路径，因此必然没有分支。
	return toTopicDTO(topic, len(path), false), nil
}

// duplicateTopicTitle 生成副本标题：原标题为空时退回默认标题；超过 maxTitleLen 时先截断
// 原标题再拼后缀，保证结果永不超长。
func duplicateTopicTitle(title string) string {
	base := strings.TrimSpace(title)
	if base == "" {
		base = defaultTopicTitle
	}
	limit := maxTitleLen - utf8.RuneCountInString(duplicateTitleSuffix)
	runes := []rune(base)
	if limit > 0 && len(runes) > limit {
		base = string(runes[:limit])
	}
	return base + duplicateTitleSuffix
}

// clonedTopicMessageStatus 把未完成的状态统一改写为 cancelled：副本不会继续生成，不能保留
// pending/streaming，否则前端会一直显示“生成中”。
func clonedTopicMessageStatus(status string) string {
	switch status {
	case "pending", "streaming":
		return "cancelled"
	default:
		return status
	}
}
