package api

import (
	"errors"
	"strings"

	"myaiui2/internal/repository"
)

// ---------------------------------------------------------------- 消息删除（子树级联）
//
// 消息以 parent_id 构成树：删除一个节点必须同时删除其全部后代，
// 否则子节点父链悬空、pathTo 走不到根。active_node_id 若落在被删
// 子树内，回退到被删子树的最近存活祖先（没有则清空到根）。

// maxDeleteMessages 单次批量删除上限，防止前端误传超大列表。
const maxDeleteMessages = 1000

// DeleteMessages 删除同一话题下的多条消息及其后代子树，返回实际删除条数。
// ids 可包含重复与「祖先+后代」组合，按子树并集去重后删除。
func (a *AppAPI) DeleteMessages(ids []string) (int, error) {
	if err := a.ready(); err != nil {
		return 0, err
	}
	if len(ids) == 0 {
		return 0, errors.New("消息 ID 列表不能为空")
	}
	if len(ids) > maxDeleteMessages {
		return 0, errors.New("单次最多删除 1000 条消息")
	}
	roots := make(map[string]struct{}, len(ids))
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if err := validateUUID("消息 ID", id); err != nil {
			return 0, err
		}
		roots[id] = struct{}{}
	}

	// 取首条消息定位话题；批量删除只允许同一话题内（前端一次只操作一个会话）。
	var first repository.Message
	for id := range roots {
		m, err := a.messages.Get(id)
		if err != nil {
			return 0, wrapRepoErr("读取消息失败", "消息不存在", err)
		}
		first = m
		break
	}
	topic, err := a.topics.Get(first.TopicID)
	if err != nil {
		return 0, wrapRepoErr("读取话题失败", "话题不存在", err)
	}
	all, err := a.messages.ListByTopicAll(topic.ID)
	if err != nil {
		return 0, wrapRepoErr("读取消息失败", "", err)
	}
	byID := make(map[string]repository.Message, len(all))
	children := make(map[string][]string, len(all))
	for _, m := range all {
		byID[m.ID] = m
		children[m.ParentID] = append(children[m.ParentID], m.ID)
	}
	for id := range roots {
		m, ok := byID[id]
		if !ok {
			return 0, errors.New("消息不存在")
		}
		if m.TopicID != topic.ID {
			return 0, errors.New("批量删除的消息必须属于同一话题")
		}
	}

	// 子树并集：从每个请求 id 向下收集全部后代。
	deleted := make(map[string]struct{}, len(roots))
	queue := make([]string, 0, len(roots)*4)
	for id := range roots {
		queue = append(queue, id)
	}
	for len(queue) > 0 {
		id := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if _, seen := deleted[id]; seen {
			continue
		}
		deleted[id] = struct{}{}
		queue = append(queue, children[id]...)
	}

	// 活动节点被删时上溯父链找最近存活祖先；整棵被删则回到根（空）。
	newActive := topic.ActiveNodeID
	if _, gone := deleted[topic.ActiveNodeID]; gone {
		newActive = ""
		for current := byID[topic.ActiveNodeID].ParentID; current != ""; {
			parent, ok := byID[current]
			if !ok {
				break
			}
			if _, gone := deleted[current]; !gone {
				newActive = current
				break
			}
			current = parent.ParentID
		}
	}

	for id := range deleted {
		if err := a.messages.Delete(id); err != nil {
			return 0, wrapRepoErr("删除消息失败", "消息不存在", err)
		}
	}
	if newActive != topic.ActiveNodeID {
		if err := a.topics.SetActiveNode(topic.ID, newActive, nowMs()); err != nil {
			return 0, wrapRepoErr("更新活动分支失败", "话题不存在", err)
		}
	}
	return len(deleted), nil
}
