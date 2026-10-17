package api

import (
	"errors"
	"strings"

	"github.com/google/uuid"

	"myaiui2/internal/repository"
)

// ---------------------------------------------------------------- 话题目录与收藏（schema v3）

// topicFolderZones 目录区域白名单：空串 = 普通区目录，'fav' = 收藏区目录。
var topicFolderZones = enumSet("", "fav")

type TopicFolderDTO struct {
	ID          string
	AssistantID string
	ParentID    string
	Name        string
	Zone        string // '' 普通目录 | 'fav' 收藏区目录
	SortOrder   int
	CreatedAt   int64
	UpdatedAt   int64
}

type SaveTopicFolderDTO struct {
	ID          string // 空=新建
	AssistantID string
	ParentID    string
	Name        string
	Zone        string
	SortOrder   int
}

type MoveTopicDTO struct {
	TopicID   string
	FolderID  string // '' = 所在 zone 的根级
	Favorite  bool
	SortOrder int // 目标容器内的插入下标（0 起，超过长度则追加）
}

type MoveTopicFolderDTO struct {
	FolderID  string
	ParentID  string // '' = 该 zone 的根级
	Zone      string // 目标 zone（'' 或 'fav'），跨 zone 移动时必须传
	SortOrder int
}

// folderRepo 延迟构造目录仓库：AppAPI 结构体保持既有字段，仓库本身无状态可随用随建。
func (a *AppAPI) folderRepo() *repository.TopicFolderRepo {
	return repository.NewTopicFolderRepo(a.db)
}

func toTopicFolderDTO(f repository.TopicFolder) TopicFolderDTO {
	return TopicFolderDTO{
		ID:          f.ID,
		AssistantID: f.AssistantID,
		ParentID:    f.ParentID,
		Name:        f.Name,
		Zone:        f.Zone,
		SortOrder:   f.SortOrder,
		CreatedAt:   f.CreatedAt,
		UpdatedAt:   f.UpdatedAt,
	}
}

// ListTopicFolders 返回助手全部话题目录（普通区与收藏区），由前端组树。
func (a *AppAPI) ListTopicFolders(assistantID string) ([]TopicFolderDTO, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	if err := validateUUID("助手 ID", assistantID); err != nil {
		return nil, err
	}
	id := strings.TrimSpace(assistantID)
	if _, err := a.assistants.Get(id); err != nil {
		return nil, wrapRepoErr("读取助手失败", "助手不存在", err)
	}
	list, err := a.folderRepo().ListByAssistant(id)
	if err != nil {
		return nil, wrapRepoErr("读取话题目录失败", "", err)
	}
	out := make([]TopicFolderDTO, 0, len(list))
	for _, item := range list {
		out = append(out, toTopicFolderDTO(item))
	}
	return out, nil
}

// SaveTopicFolder 新建目录（ID 为空）或仅重命名（ID 非空时 parent/zone/sort_order 不变）。
func (a *AppAPI) SaveTopicFolder(input SaveTopicFolderDTO) (TopicFolderDTO, error) {
	if err := a.ready(); err != nil {
		return TopicFolderDTO{}, err
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		return TopicFolderDTO{}, errors.New("目录名称不能为空")
	}
	if err := validateTextLen("目录名称", name, maxNameLen); err != nil {
		return TopicFolderDTO{}, err
	}

	now := nowMs()
	// 改名路径：只更新 name，parent/zone/sort_order 保持现状。
	if strings.TrimSpace(input.ID) != "" {
		if err := validateUUID("目录 ID", input.ID); err != nil {
			return TopicFolderDTO{}, err
		}
		folder, err := a.folderRepo().Get(strings.TrimSpace(input.ID))
		if err != nil {
			return TopicFolderDTO{}, wrapRepoErr("读取话题目录失败", "话题目录不存在", err)
		}
		folder.Name = name
		folder.UpdatedAt = now
		if err := a.folderRepo().Update(folder); err != nil {
			return TopicFolderDTO{}, wrapRepoErr("保存话题目录失败", "话题目录不存在", err)
		}
		return toTopicFolderDTO(folder), nil
	}

	if err := validateUUID("助手 ID", input.AssistantID); err != nil {
		return TopicFolderDTO{}, err
	}
	assistantID := strings.TrimSpace(input.AssistantID)
	if _, err := a.assistants.Get(assistantID); err != nil {
		return TopicFolderDTO{}, wrapRepoErr("读取助手失败", "助手不存在", err)
	}
	zone := strings.TrimSpace(input.Zone)
	if err := validateEnum("目录区域", zone, topicFolderZones); err != nil {
		return TopicFolderDTO{}, err
	}
	parentID := strings.TrimSpace(input.ParentID)
	folder := repository.TopicFolder{
		ID:          uuid.NewString(),
		AssistantID: assistantID,
		ParentID:    parentID,
		Name:        name,
		Zone:        zone,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if parentID != "" {
		if err := a.validateFolderParent(assistantID, parentID, zone, folder.ID); err != nil {
			return TopicFolderDTO{}, err
		}
	}
	// 新建目录排在同父容器的末尾。
	siblings, err := a.folderRepo().ListChildren(assistantID, parentID, zone)
	if err != nil {
		return TopicFolderDTO{}, wrapRepoErr("读取话题目录失败", "", err)
	}
	folder.SortOrder = len(siblings)
	if err := a.folderRepo().Create(folder); err != nil {
		return TopicFolderDTO{}, wrapRepoErr("保存话题目录失败", "", err)
	}
	return toTopicFolderDTO(folder), nil
}

// validateFolderParent 校验目标父目录：存在、属于同一助手、zone 一致、且祖先链不含 folderID（防环）。
func (a *AppAPI) validateFolderParent(assistantID string, parentID string, zone string, folderID string) error {
	if err := validateUUID("父目录 ID", parentID); err != nil {
		return err
	}
	parent, err := a.folderRepo().Get(parentID)
	if err != nil {
		return wrapRepoErr("读取话题目录失败", "父目录不存在", err)
	}
	if parent.AssistantID != assistantID {
		return errors.New("父目录不属于该助手")
	}
	if parent.Zone != zone {
		return errors.New("父目录与目标区域不一致")
	}
	// 沿 parent 链上溯：链中一旦出现自身即构成环（新建时 ID 全新，此检查恒不命中）。
	has, err := a.folderAncestorHas(assistantID, parentID, folderID)
	if err != nil {
		return err
	}
	if has {
		return errors.New("不能把目录放到自身或其子目录下")
	}
	return nil
}

// folderAncestorHas 从 startID 沿 parent_id 上溯，检查祖先链中是否包含 targetID；visited 防环。
func (a *AppAPI) folderAncestorHas(assistantID string, startID string, targetID string) (bool, error) {
	if startID == "" || targetID == "" {
		return false, nil
	}
	all, err := a.folderRepo().ListByAssistant(assistantID)
	if err != nil {
		return false, wrapRepoErr("读取话题目录失败", "", err)
	}
	byID := make(map[string]repository.TopicFolder, len(all))
	for _, f := range all {
		byID[f.ID] = f
	}
	visited := make(map[string]struct{}, len(all))
	for current := startID; current != ""; {
		if current == targetID {
			return true, nil
		}
		if _, seen := visited[current]; seen {
			break
		}
		visited[current] = struct{}{}
		folder, ok := byID[current]
		if !ok {
			break
		}
		current = folder.ParentID
	}
	return false, nil
}

// DeleteTopicFolder 删除目录但不级联删数据：子目录与话题都提升到被删目录的父级。
func (a *AppAPI) DeleteTopicFolder(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := validateUUID("目录 ID", id); err != nil {
		return err
	}
	folder, err := a.folderRepo().Get(strings.TrimSpace(id))
	if err != nil {
		return wrapRepoErr("读取话题目录失败", "话题目录不存在", err)
	}
	// 子目录提升一级：parent_id 改到被删目录的 parent_id，排序下标保持原值。
	children, err := a.folderRepo().ListChildren(folder.AssistantID, folder.ID, folder.Zone)
	if err != nil {
		return wrapRepoErr("读取话题目录失败", "", err)
	}
	for _, child := range children {
		if err := a.folderRepo().SetParentAndOrder(child.ID, folder.ParentID, child.Zone, child.SortOrder); err != nil {
			return wrapRepoErr("调整子目录失败", "话题目录不存在", err)
		}
	}
	// 目录下话题提升一级：folder_id 改到被删目录的 parent_id，favorite 保持不变。
	now := nowMs()
	for _, favorite := range []bool{false, true} {
		topics, err := a.topics.ListSiblings(folder.AssistantID, folder.ID, favorite)
		if err != nil {
			return wrapRepoErr("读取话题失败", "", err)
		}
		for _, topic := range topics {
			if err := a.topics.SetPlacement(topic.ID, folder.ParentID, topic.Favorite, now); err != nil {
				return wrapRepoErr("调整话题位置失败", "话题不存在", err)
			}
		}
	}
	if err := a.folderRepo().Delete(folder.ID); err != nil {
		return wrapRepoErr("删除话题目录失败", "话题目录不存在", err)
	}
	return nil
}

// MoveTopic 把话题移动到目标容器（folder_id + favorite 标识），并按 SortOrder 下标重写同级排序。
func (a *AppAPI) MoveTopic(input MoveTopicDTO) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := validateUUID("话题 ID", input.TopicID); err != nil {
		return err
	}
	topic, err := a.topics.Get(strings.TrimSpace(input.TopicID))
	if err != nil {
		return wrapRepoErr("读取话题失败", "话题不存在", err)
	}
	folderID := strings.TrimSpace(input.FolderID)
	if folderID != "" {
		if err := validateUUID("目录 ID", folderID); err != nil {
			return err
		}
		folder, err := a.folderRepo().Get(folderID)
		if err != nil {
			return wrapRepoErr("读取话题目录失败", "话题目录不存在", err)
		}
		if folder.AssistantID != topic.AssistantID {
			return errors.New("目录不属于该助手")
		}
		// 收藏话题只能进收藏区目录，普通话题只能进普通区目录。
		if input.Favorite && folder.Zone != "fav" {
			return errors.New("目录与目标区域不一致")
		}
		if !input.Favorite && folder.Zone != "" {
			return errors.New("目录与目标区域不一致")
		}
	}

	now := nowMs()
	if err := a.topics.SetPlacement(topic.ID, folderID, input.Favorite, now); err != nil {
		return wrapRepoErr("移动话题失败", "话题不存在", err)
	}
	// 目标容器内按 (sort_order, updated_at) 排序后把本话题插到指定下标，再重写 0..n-1。
	siblings, err := a.topics.ListSiblings(topic.AssistantID, folderID, input.Favorite)
	if err != nil {
		return wrapRepoErr("读取话题失败", "", err)
	}
	ordered := reorderTopic(siblings, topic.ID, input.SortOrder)
	for index, item := range ordered {
		if err := a.topics.SetSortOrder(item.ID, index); err != nil {
			return wrapRepoErr("调整话题排序失败", "话题不存在", err)
		}
	}
	return nil
}

// reorderTopic 把 topicID 从列表中取出并插到 index 下标处（越界自动收敛到两端）。
func reorderTopic(list []repository.Topic, topicID string, index int) []repository.Topic {
	rest := make([]repository.Topic, 0, len(list))
	var moved repository.Topic
	found := false
	for _, item := range list {
		if item.ID == topicID {
			moved = item
			found = true
			continue
		}
		rest = append(rest, item)
	}
	if !found {
		return list
	}
	if index < 0 {
		index = 0
	}
	if index > len(rest) {
		index = len(rest)
	}
	out := make([]repository.Topic, 0, len(list))
	out = append(out, rest[:index]...)
	out = append(out, moved)
	return append(out, rest[index:]...)
}

// MoveTopicFolder 把目录移动到目标父目录/区域，并按 SortOrder 下标重写同级排序。
func (a *AppAPI) MoveTopicFolder(input MoveTopicFolderDTO) error {
	if err := a.ready(); err != nil {
		return err
	}
	if err := validateUUID("目录 ID", input.FolderID); err != nil {
		return err
	}
	folder, err := a.folderRepo().Get(strings.TrimSpace(input.FolderID))
	if err != nil {
		return wrapRepoErr("读取话题目录失败", "话题目录不存在", err)
	}
	zone := strings.TrimSpace(input.Zone)
	if err := validateEnum("目录区域", zone, topicFolderZones); err != nil {
		return err
	}
	parentID := strings.TrimSpace(input.ParentID)
	if parentID != "" {
		if err := a.validateFolderParent(folder.AssistantID, parentID, zone, folder.ID); err != nil {
			return err
		}
	}

	if err := a.folderRepo().SetParentAndOrder(folder.ID, parentID, zone, input.SortOrder); err != nil {
		return wrapRepoErr("移动话题目录失败", "话题目录不存在", err)
	}
	// 目标容器内按 (sort_order, updated_at) 排序后把本目录插到指定下标，再重写 0..n-1。
	siblings, err := a.folderRepo().ListChildren(folder.AssistantID, parentID, zone)
	if err != nil {
		return wrapRepoErr("读取话题目录失败", "", err)
	}
	ordered := reorderTopicFolder(siblings, folder.ID, input.SortOrder)
	for index, item := range ordered {
		if err := a.folderRepo().SetParentAndOrder(item.ID, parentID, zone, index); err != nil {
			return wrapRepoErr("调整目录排序失败", "话题目录不存在", err)
		}
	}
	return nil
}

// reorderTopicFolder 把 folderID 从列表中取出并插到 index 下标处（越界自动收敛到两端）。
func reorderTopicFolder(list []repository.TopicFolder, folderID string, index int) []repository.TopicFolder {
	rest := make([]repository.TopicFolder, 0, len(list))
	var moved repository.TopicFolder
	found := false
	for _, item := range list {
		if item.ID == folderID {
			moved = item
			found = true
			continue
		}
		rest = append(rest, item)
	}
	if !found {
		return list
	}
	if index < 0 {
		index = 0
	}
	if index > len(rest) {
		index = len(rest)
	}
	out := make([]repository.TopicFolder, 0, len(list))
	out = append(out, rest[:index]...)
	out = append(out, moved)
	return append(out, rest[index:]...)
}

// PurgeMissingModels 删除该服务商下所有「失联且来源为 synced」的模型，返回删除数量。
// 复用 DeleteModel 的路径：先解除助手的 model_id 引用，再删模型行。
func (a *AppAPI) PurgeMissingModels(providerID string) (int, error) {
	if err := a.ready(); err != nil {
		return 0, err
	}
	if err := validateUUID("模型服务 ID", providerID); err != nil {
		return 0, err
	}
	id := strings.TrimSpace(providerID)
	models, err := a.models.List(id)
	if err != nil {
		return 0, wrapRepoErr("读取模型失败", "", err)
	}
	purged := 0
	for _, m := range models {
		if !m.MissingRemote || m.Source != "synced" {
			continue
		}
		if err := a.clearAssistantReferences(m.ID, false); err != nil {
			return purged, err
		}
		if err := a.models.Delete(m.ID); err != nil {
			return purged, wrapRepoErr("删除模型失败", "模型不存在", err)
		}
		purged++
	}
	return purged, nil
}
