package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin/plugintest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
)

// fakeKV backs the plugintest API with a store that honours compare-and-set, so
// the retry path in mutateVoiceRooms runs for real instead of being stubbed out.
type fakeKV struct {
	values            map[string][]byte
	posts             map[string]*model.Post
	webSocketEvents   []string
	webSocketPayloads []map[string]interface{}
	webSocketTargets  []string
}

// Creating a voice channel is a system-admin action, so the fixture's creator
// holds that permission. Every other name in these tests is an ordinary user.
const testAdmin = "creator"

func newVoiceRoomsPlugin(admins ...string) (*Plugin, *fakeKV) {
	admins = append(admins, testAdmin)

	kv := &fakeKV{values: map[string][]byte{}, posts: map[string]*model.Post{}}
	api := &plugintest.API{}

	api.On("KVGet", mock.AnythingOfType("string")).Return(
		func(key string) []byte {
			return kv.values[key]
		},
		func(key string) *model.AppError {
			return nil
		},
	)

	api.On("KVSetWithOptions", mock.AnythingOfType("string"), mock.Anything, mock.Anything).Return(
		func(key string, value []byte, options model.PluginKVSetOptions) bool {
			if options.Atomic && !bytes.Equal(kv.values[key], options.OldValue) {
				return false
			}
			kv.values[key] = value
			return true
		},
		func(key string, value []byte, options model.PluginKVSetOptions) *model.AppError {
			return nil
		},
	)

	api.On("HasPermissionTo", mock.AnythingOfType("string"), mock.Anything).Return(
		func(userID string, permission *model.Permission) bool {
			for _, admin := range admins {
				if admin == userID {
					return true
				}
			}
			return false
		},
	)

	api.On("LogWarn", mock.Anything, mock.Anything, mock.Anything).Maybe()
	api.On("PublishWebSocketEvent", mock.AnythingOfType("string"), mock.Anything, mock.Anything).Run(func(args mock.Arguments) {
		kv.webSocketEvents = append(kv.webSocketEvents, args.String(0))
		kv.webSocketPayloads = append(kv.webSocketPayloads, args.Get(1).(map[string]interface{}))
		broadcast, _ := args.Get(2).(*model.WebsocketBroadcast)
		if broadcast != nil {
			kv.webSocketTargets = append(kv.webSocketTargets, broadcast.UserId)
		} else {
			kv.webSocketTargets = append(kv.webSocketTargets, "")
		}
	}).Maybe()

	// Presence resolves names through the server so a viewer who never opened
	// the room can still see who is in it.
	api.On("GetUser", mock.AnythingOfType("string")).Return(
		func(userID string) *model.User {
			return &model.User{Id: userID, Username: userID + "-handle", FirstName: "First", LastName: userID}
		},
		func(userID string) *model.AppError {
			return nil
		},
	).Maybe()

	api.On("GetDirectChannel", mock.AnythingOfType("string"), mock.AnythingOfType("string")).Return(
		func(userID1, userID2 string) *model.Channel {
			return &model.Channel{Id: "dm-" + userID1 + "-" + userID2, Type: model.ChannelTypeDirect}
		},
		func(userID1, userID2 string) *model.AppError {
			return nil
		},
	).Maybe()

	api.On("CreatePost", mock.AnythingOfType("*model.Post")).Return(
		func(post *model.Post) *model.Post {
			// model.Post contains a mutex, so test fixtures must not copy it by value.
			post.Id = "post-" + strconv.Itoa(len(kv.posts)+1)
			kv.posts[post.Id] = post
			return post
		},
		func(post *model.Post) *model.AppError {
			return nil
		},
	).Maybe()

	api.On("GetPost", mock.AnythingOfType("string")).Return(
		func(postID string) *model.Post {
			return kv.posts[postID]
		},
		func(postID string) *model.AppError {
			return nil
		},
	).Maybe()

	api.On("UpdatePost", mock.AnythingOfType("*model.Post")).Return(
		func(post *model.Post) *model.Post {
			kv.posts[post.Id] = post
			return post
		},
		func(post *model.Post) *model.AppError {
			return nil
		},
	).Maybe()

	p := &Plugin{}
	p.SetAPI(api)
	return p, kv
}

func voiceRoomsRequest(p *Plugin, method, target, userID string, body interface{}) *httptest.ResponseRecorder {
	var r *http.Request
	if body == nil {
		r = httptest.NewRequest(method, target, nil)
	} else {
		encoded, err := json.Marshal(body)
		if err != nil {
			panic(err)
		}
		r = httptest.NewRequest(method, target, bytes.NewReader(encoded))
	}
	if userID != "" {
		r.Header.Set("Mattermost-User-Id", userID)
	}

	w := httptest.NewRecorder()
	p.ServeHTTP(nil, w, r)
	return w
}

func decodeVoiceRooms(t *testing.T, w *httptest.ResponseRecorder) []voiceRoom {
	t.Helper()
	var payload struct {
		Rooms []voiceRoom `json:"rooms"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	return payload.Rooms
}

func createVoiceRoom(p *Plugin, userID, roomID, name string) *httptest.ResponseRecorder {
	return voiceRoomsRequest(p, http.MethodPost, "/v1/voice/rooms", userID, map[string]string{
		"roomId": roomID,
		"name":   name,
	})
}

func TestVoiceRoomsRequireAuthentication(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()

	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
		w := voiceRoomsRequest(p, method, "/v1/voice/rooms?roomId=r1", "", nil)
		assert.Equal(t, http.StatusForbidden, w.Code, "method %s", method)
	}
}

func TestVoiceRoomsListEmptyIsArrayNotNull(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()

	w := voiceRoomsRequest(p, http.MethodGet, "/v1/voice/rooms", "user1", nil)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.JSONEq(t, `{"rooms":[]}`, w.Body.String())
}

// The bug this endpoint exists to fix: a room created by one user was invisible
// to everybody else, because the directory only ever lived in the creator's
// localStorage plus a one-shot broadcast nobody was guaranteed to hear.
func TestVoiceRoomCreatedByOneUserIsVisibleToAnother(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()

	created := createVoiceRoom(p, "creator", "room-1", "Design sync")
	require.Equal(t, http.StatusOK, created.Code)

	w := voiceRoomsRequest(p, http.MethodGet, "/v1/voice/rooms", "someone-else", nil)
	require.Equal(t, http.StatusOK, w.Code)

	rooms := decodeVoiceRooms(t, w)
	require.Len(t, rooms, 1)
	assert.Equal(t, "room-1", rooms[0].RoomID)
	assert.Equal(t, "Design sync", rooms[0].Name)
	assert.Equal(t, "creator", rooms[0].CreatorID)
	assert.NotZero(t, rooms[0].CreateAt)
}

func TestVoiceRoomCreateIsIdempotentAndCannotBeHijacked(t *testing.T) {
	p, _ := newVoiceRoomsPlugin("other-admin")

	require.Equal(t, http.StatusOK, createVoiceRoom(p, testAdmin, "room-1", "Original").Code)

	// A second announce for the same id, by a different administrator, must not
	// rename the room or transfer ownership.
	w := createVoiceRoom(p, "other-admin", "room-1", "Renamed")
	require.Equal(t, http.StatusOK, w.Code)

	rooms := decodeVoiceRooms(t, w)
	require.Len(t, rooms, 1)
	assert.Equal(t, "Original", rooms[0].Name)
	assert.Equal(t, testAdmin, rooms[0].CreatorID)
}

// Hiding the button restricts nothing on its own: the endpoint is reachable by
// any logged-in user.
func TestVoiceRoomCreateRequiresSystemAdmin(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()

	w := createVoiceRoom(p, "ordinary-user", "room-1", "Standup")
	assert.Equal(t, http.StatusForbidden, w.Code)

	list := voiceRoomsRequest(p, http.MethodGet, "/v1/voice/rooms", "ordinary-user", nil)
	assert.Empty(t, decodeVoiceRooms(t, list), "a refused create must not leave a room behind")
}

func TestVoiceRoomCreateValidation(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()

	longName := string(bytes.Repeat([]byte("a"), maxVoiceRoomNameLen+1))
	longID := string(bytes.Repeat([]byte("b"), maxVoiceRoomIDLen+1))

	cases := map[string]struct{ roomID, name string }{
		"empty room id":    {"", "Room"},
		"empty name":       {"room-1", ""},
		"blank name":       {"room-1", "   "},
		"name too long":    {"room-1", longName},
		"room id too long": {longID, "Room"},
	}

	for label, tc := range cases {
		w := createVoiceRoom(p, testAdmin, tc.roomID, tc.name)
		assert.Equal(t, http.StatusBadRequest, w.Code, label)
	}
}

func TestVoiceRoomDeleteRequiresCreator(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, "creator", "room-1", "Room").Code)

	w := voiceRoomsRequest(p, http.MethodDelete, "/v1/voice/rooms?roomId=room-1", "intruder", nil)
	assert.Equal(t, http.StatusForbidden, w.Code)

	list := voiceRoomsRequest(p, http.MethodGet, "/v1/voice/rooms", "intruder", nil)
	assert.Len(t, decodeVoiceRooms(t, list), 1, "room must survive a rejected delete")
}

func TestVoiceRoomDeleteByCreator(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()
	require.Equal(t, http.StatusOK, createVoiceRoom(p, "creator", "room-1", "Room").Code)

	w := voiceRoomsRequest(p, http.MethodDelete, "/v1/voice/rooms?roomId=room-1", "creator", nil)
	require.Equal(t, http.StatusOK, w.Code)
	assert.Empty(t, decodeVoiceRooms(t, w))
}

func TestVoiceRoomDeleteBySystemAdmin(t *testing.T) {
	p, _ := newVoiceRoomsPlugin("admin")
	require.Equal(t, http.StatusOK, createVoiceRoom(p, "creator", "room-1", "Room").Code)

	w := voiceRoomsRequest(p, http.MethodDelete, "/v1/voice/rooms?roomId=room-1", "admin", nil)
	require.Equal(t, http.StatusOK, w.Code)
	assert.Empty(t, decodeVoiceRooms(t, w))
}

func TestVoiceRoomDeleteUnknownRoomSucceeds(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()

	w := voiceRoomsRequest(p, http.MethodDelete, "/v1/voice/rooms?roomId=nope", "user1", nil)
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestVoiceRoomDeleteRequiresRoomID(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()

	w := voiceRoomsRequest(p, http.MethodDelete, "/v1/voice/rooms", "user1", nil)
	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestVoiceRoomsMethodNotAllowed(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()

	w := voiceRoomsRequest(p, http.MethodPut, "/v1/voice/rooms", "user1", nil)
	assert.Equal(t, http.StatusMethodNotAllowed, w.Code)
}

func TestVoiceRoomsAreSortedCaseInsensitively(t *testing.T) {
	p, _ := newVoiceRoomsPlugin()

	require.Equal(t, http.StatusOK, createVoiceRoom(p, testAdmin, "r1", "zebra").Code)
	require.Equal(t, http.StatusOK, createVoiceRoom(p, testAdmin, "r2", "Alpha").Code)
	require.Equal(t, http.StatusOK, createVoiceRoom(p, testAdmin, "r3", "beta").Code)

	rooms := decodeVoiceRooms(t, voiceRoomsRequest(p, http.MethodGet, "/v1/voice/rooms", "u", nil))
	require.Len(t, rooms, 3)
	assert.Equal(t, []string{"Alpha", "beta", "zebra"}, []string{rooms[0].Name, rooms[1].Name, rooms[2].Name})
}

func TestVoiceRoomsLimit(t *testing.T) {
	p, kv := newVoiceRoomsPlugin()

	full := make([]voiceRoom, 0, maxVoiceRooms)
	for i := 0; i < maxVoiceRooms; i++ {
		full = append(full, voiceRoom{
			RoomID:    "seed-" + strconv.Itoa(i),
			Name:      "Room",
			CreatorID: "u",
		})
	}
	encoded, err := json.Marshal(full)
	require.NoError(t, err)
	kv.values[voiceRoomsKey] = encoded

	w := createVoiceRoom(p, testAdmin, "one-too-many", "Room")
	assert.Equal(t, http.StatusConflict, w.Code)
}

// A value that cannot be decoded must not wedge the directory forever.
func TestVoiceRoomsRecoverFromCorruptValue(t *testing.T) {
	p, kv := newVoiceRoomsPlugin()
	kv.values[voiceRoomsKey] = []byte("{not json")

	list := voiceRoomsRequest(p, http.MethodGet, "/v1/voice/rooms", "u", nil)
	require.Equal(t, http.StatusOK, list.Code)
	assert.Empty(t, decodeVoiceRooms(t, list))

	w := createVoiceRoom(p, testAdmin, "room-1", "Fresh start")
	require.Equal(t, http.StatusOK, w.Code)
	assert.Len(t, decodeVoiceRooms(t, w), 1)
}
