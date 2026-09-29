package main

import (
	"errors"
	"fmt"

	"github.com/mattermost/mattermost/server/public/model"
)

var (
	errVoiceInviteUserNotFound    = errors.New("invited user not found")
	errVoiceInviteInviterNotFound = errors.New("inviting user not found")
	errVoiceInviteDirectChannel   = errors.New("could not create direct channel")
	errVoiceInviteCreatePost      = errors.New("could not create invitation message")
	errVoiceInviteUpdatePost      = errors.New("could not update invitation message")
	errVoiceInvitePostNotFound    = errors.New("invitation message not found")
)

// voiceInviteGateway isolates Mattermost user, post, and event operations from
// invitation rules. The Plugin adapter remains the only API-dependent part.
type voiceInviteGateway interface {
	inviteUser(string) (*model.User, error)
	inviteDirectChannel(string, string) (*model.Channel, error)
	inviteCreatePost(*model.Post) (*model.Post, error)
	inviteGetPost(string) (*model.Post, error)
	inviteUpdatePost(*model.Post) error
	invitePublish(map[string]interface{}, string)
}

type voiceInviteService struct {
	rooms   voiceRoomService
	gateway voiceInviteGateway
}

func (s voiceInviteService) send(inviterID, targetID, roomID string) error {
	if inviterID == targetID {
		return errVoiceInviteSelf
	}
	target, err := s.gateway.inviteUser(targetID)
	if err != nil || target == nil || target.DeleteAt != 0 {
		return errVoiceInviteUserNotFound
	}
	room, err := s.rooms.inviteRoom(inviterID, targetID, roomID)
	if err != nil {
		return err
	}
	inviter, err := s.gateway.inviteUser(inviterID)
	if err != nil || inviter == nil || inviter.DeleteAt != 0 {
		return errVoiceInviteInviterNotFound
	}
	invite := voiceInviteRecord{
		InviteID: model.NewId(), RoomID: room.RoomID, RoomName: room.Name,
		RoomCreateAt: room.CreateAt, RoomGeneration: room.Generation,
		InviterID: inviterID, InviterUsername: inviter.Username,
		InviterFirstName: inviter.FirstName, InviterLastName: inviter.LastName,
		TargetUserID: targetID, TargetUsername: target.Username,
		ExpiresAt: model.GetMillis() + voiceInviteTTLMillis, Status: voiceInvitePending,
	}
	channel, err := s.gateway.inviteDirectChannel(inviterID, targetID)
	if err != nil || channel == nil {
		return errVoiceInviteDirectChannel
	}
	message := fmt.Sprintf("**Voice channel invitation** — @%s, @%s invited you to join **%s**. This invitation expires in five minutes.", target.Username, inviter.Username, room.Name)
	post, err := s.gateway.inviteCreatePost(&model.Post{
		UserId: inviterID, ChannelId: channel.Id, Message: message,
		Type:  voiceInvitePostType,
		Props: map[string]interface{}{voiceInvitePropsKey: invite.asMap()},
	})
	if err != nil || post == nil {
		return errVoiceInviteCreatePost
	}
	if err := s.rooms.validateInviteResponse(invite); err != nil {
		if errors.Is(err, errVoiceInviteExpired) {
			if updateErr := s.expireInvitePost(post, invite); updateErr != nil {
				return updateErr
			}
		}
		return err
	}
	payload := invite.asMap()
	payload["postId"] = post.Id
	s.gateway.invitePublish(payload, targetID)
	return nil
}

func (s voiceInviteService) respond(userID, postID, inviteID, decision string) error {
	post, err := s.gateway.inviteGetPost(postID)
	if err != nil || post == nil {
		return errVoiceInvitePostNotFound
	}
	invite, err := voiceInviteFromPost(post)
	if err != nil || invite.InviteID != inviteID {
		return errVoiceInvitePostInvalid
	}
	if invite.TargetUserID != userID {
		return errVoiceInviteWrongTarget
	}
	if invite.ExpiresAt <= model.GetMillis() {
		return errVoiceInviteExpired
	}
	if err := s.rooms.validateInviteRoom(invite); err != nil {
		return err
	}
	if invite.Status != voiceInvitePending {
		if invite.Status == decision {
			return nil
		}
		return errVoiceInviteAlreadyAnswered
	}
	if err := s.rooms.validateInviteResponse(invite); err != nil {
		return err
	}
	invite.Status = decision
	updated := post.Clone()
	updated.Props = make(map[string]interface{}, len(post.Props))
	for key, value := range post.Props {
		updated.Props[key] = value
	}
	updated.Props[voiceInvitePropsKey] = invite.asMap()
	if err := s.gateway.inviteUpdatePost(updated); err != nil {
		return errVoiceInviteUpdatePost
	}
	if err := s.rooms.validateInviteResponse(invite); err != nil {
		if errors.Is(err, errVoiceInviteExpired) {
			if updateErr := s.expireInvitePost(updated, invite); updateErr != nil {
				return updateErr
			}
		}
		return err
	}
	return nil
}

func (s voiceInviteService) expireInvitePost(post *model.Post, invite voiceInviteRecord) error {
	invite.Status = voiceInvitePending
	invite.ExpiresAt = model.GetMillis() - 1
	updated := post.Clone()
	updated.Props = make(map[string]interface{}, len(post.Props))
	for key, value := range post.Props {
		updated.Props[key] = value
	}
	updated.Props[voiceInvitePropsKey] = invite.asMap()
	if err := s.gateway.inviteUpdatePost(updated); err != nil {
		return errVoiceInviteUpdatePost
	}
	return nil
}

func (p *Plugin) inviteUser(id string) (*model.User, error) {
	user, appErr := p.API.GetUser(id)
	if appErr != nil {
		return nil, appErr
	}
	return user, nil
}

func (p *Plugin) inviteDirectChannel(inviterID, targetID string) (*model.Channel, error) {
	channel, appErr := p.API.GetDirectChannel(inviterID, targetID)
	if appErr != nil {
		return nil, appErr
	}
	return channel, nil
}

func (p *Plugin) inviteCreatePost(post *model.Post) (*model.Post, error) {
	created, appErr := p.API.CreatePost(post)
	if appErr != nil {
		return nil, appErr
	}
	return created, nil
}

func (p *Plugin) inviteGetPost(id string) (*model.Post, error) {
	post, appErr := p.API.GetPost(id)
	if appErr != nil {
		return nil, appErr
	}
	return post, nil
}

func (p *Plugin) inviteUpdatePost(post *model.Post) error {
	_, appErr := p.API.UpdatePost(post)
	if appErr != nil {
		return appErr
	}
	return nil
}

func (p *Plugin) invitePublish(payload map[string]interface{}, targetID string) {
	p.API.PublishWebSocketEvent(voiceInviteEvent, payload, &model.WebsocketBroadcast{UserId: targetID})
}
