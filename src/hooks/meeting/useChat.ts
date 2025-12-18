/**
 * useChat Hook
 * 
 * Manages chat functionality
 */

import { useCallback, useMemo } from 'react';
import { useMeetingStore } from '../../store/meetingStore.js';
import { signalingClient } from '../../services/signaling/index.js';
import { peerConnectionManager } from '../../services/webrtc/index.js';
import type { ChatMessage } from '../../types/index.js';

export const useChat = () => {
  const messages = useMeetingStore(state => state.messages);
  const participants = useMeetingStore(state => state.participants);
  const localParticipant = useMeetingStore(state => state.localParticipant);
  const addMessage = useMeetingStore(state => state.addMessage);
  const clearMessages = useMeetingStore(state => state.clearMessages);

  /**
   * Send a chat message
   */
  const sendMessage = useCallback((message: string) => {
    if (!message.trim() || !localParticipant) {
      return;
    }

    const chatMessage: ChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      from: localParticipant.id,
      fromName: localParticipant.name,
      message: message.trim(),
      timestamp: Date.now()
    };

    // Add to local store (optimistic update)
    addMessage(chatMessage);

    // Send via signaling server
    signalingClient.sendChatMessage(message.trim());

    // Also send via data channels (fallback)
    peerConnectionManager.broadcastMessage(JSON.stringify({
      type: 'chat',
      ...chatMessage
    }));
  }, [localParticipant, addMessage]);

  /**
   * Get non-system messages
   */
  const userMessages = useMemo(() => {
    return messages.filter(msg => !(msg as any).isSystem);
  }, [messages]);

  /**
   * Get system messages
   */
  const systemMessages = useMemo(() => {
    return messages.filter(msg => (msg as any).isSystem);
  }, [messages]);

  return {
    messages,
    userMessages,
    systemMessages,
    sendMessage,
    clearMessages
  };
};

