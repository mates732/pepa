cd /Users/matyasvojan/Desktop/PEPA\ the\ outman
supabase db query --linked --file supabase/verify/sequence-separation.sql > /tmp/seqsep.stdout 2> /tmp/seqsep.stderr
echo "EXIT=$?" >> /tmp/seqsep.stderr
