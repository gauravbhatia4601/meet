/**
 * useParticipants Hook
 * 
 * Manages participants in the meeting
 */

import { useMemo, useCallback } from 'react';
import { useMeetingStore } from '../../store/meetingStore.js';
import type { Participant } from '../../types/index.js';

export const useParticipants = () => {
  const participants = useMeetingStore(state => state.participants);
  const localParticipant = useMeetingStore(state => state.localParticipant);
  const isHost = useMeetingStore(state => state.isHost);
  const updateParticipant = useMeetingStore(state => state.updateParticipant);

  /**
   * Get remote participants (excluding local)
   */
  const remoteParticipants = useMemo(() => {
    return participants.filter(p => !p.isLocal);
  }, [participants]);

  /**
   * Get participant by peer ID
   */
  const getParticipant = useCallback((peerId: string): Participant | undefined => {
    return participants.find(p => p.peerId === peerId);
  }, [participants]);

  /**
   * Check if participant is speaking
   */
  const setParticipantSpeaking = useCallback((peerId: string, isSpeaking: boolean) => {
    updateParticipant(peerId, { isSpeaking });
  }, [updateParticipant]);

  /**
   * Get participant count (including local participant)
   */
  const participantCount = useMemo(() => {
    const remoteCount = participants.filter(p => !p.isLocal).length;
    const localCount = localParticipant ? 1 : 0;
    return remoteCount + localCount;
  }, [participants, localParticipant]);

  return {
    participants,
    localParticipant,
    remoteParticipants,
    isHost,
    participantCount,
    getParticipant,
    setParticipantSpeaking
  };
};

