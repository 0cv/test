trigger Pebble_Post_Action on Pebble_Post__c (after insert) {
  system.debug('DEBUG: Pebble_ Post Action Started');
  String id15;
  Pebble_Post__c[] newPostList = Trigger.new;
  Pebble_Post__c newPost = newPostList[0];
  Map<String, Pebble_Row__c> customNoteList = new Map<String, Pebble_Row__c>();  
  for (Pebble_Row__c pr : [SELECT Id, Name, Custom_Note__c, Custom_Detail__c FROM Pebble_Row__c WHERE Pebble_App__c =: newPost.Pebble_App__c] ) {
            customNoteList.put(pr.Name, pr);
            }
    system.debug('LIST DONE');
    system.debug(customNoteList); 
    
    try {  
        //Now find the components from the Pebble_Row to execute the Action
        String rowCodes = newPost.Row_Codes__c;
        List<String> listCode = rowCodes.split('-');
        Pebble_Row__c foundRow = new Pebble_Row__c();

        
    if (newPost.Action__c == 'Chatter') {
        //Posting to Chatter requires the Row_Codes__ to be in the following formate
        //Chatter-<Pebble Row Name of the record to post to>-<Pebble Row Name of the Message>
        
        //Adding a Text post to Chatter
        FeedItem post = new FeedItem();

        //Get the UUID for the record to which should have the Chatter Post
        //The UUID is stored in the Custom NOTE field
        foundRow = customNoteList.get(listCode[1]);
        post.ParentId = foundRow.Custom_Note__c.trim();
        system.debug('OK - Note done');
     
        //Get the Message that is to be displayed in Chatter
        //Due to the possible length the Message is stored in the Custom DETAIL field
        foundRow = customNoteList.get(listCode[2]);
        system.debug('FOUND:'+foundRow);
        post.Body = foundRow.Custom_Detail__c.trim();
        system.debug('OK - Detail done');

        insert post;
        id15 = post.id;          
    }
          
    if (newPost.Action__c == 'Case') {
        //Creating a Case requires the Row_Codes__ to be in the following formate
        //Case-<Pebble Row Name of priority>-<Pebble Row Name of the Contact>-<Pebble Row Name of the Subject>
        
        Case pc = new Case();
        //By default assume the Status and Origin
        pc.Status = 'New';
        pc.Origin = 'Pebble';
        pc.Description = 'This case has been opened on the Pebble Watch '
            + 'and will be updated with details shortly.';

        //Get the selected Priority
        foundRow = customNoteList.get(listCode[1]);
        system.debug('FOUND Priority:'+foundRow);
        pc.Priority = foundRow.Custom_Note__c.trim();
        system.debug('OK - Detail done');

        foundRow = customNoteList.get(listCode[2]);
       if (foundRow.Custom_Note__c != null) {  //Make sure it is not null first
        system.debug('FOUND ContactID:'+foundRow);
           if (foundRow.Custom_Note__c.trim().length() == 15) {
            //Only try to set the link to the Contact if it is 15 character UUID
            pc.ContactId = foundRow.Custom_Note__c.trim();
           } else {
            system.debug('ERROR: Could not find a valid UUID for the Case record.');
            pc.ContactId = newPost.Id;
           }
          }
        
  
        //Add the Subject line and the Type
        foundRow = customNoteList.get(listCode[3]);
        pc.Subject = foundRow.Custom_Detail__c.trim();
        pc.Type = foundRow.Custom_Note__c.trim();
       
        //Create the Case
        insert pc;
        id15 = pc.id;  
     }  // End of NEW CASE if statement
          
        //Now update the Pebble_Post record to show it is completed and provide a link
        FeedItem postComplete = new FeedItem();
        postComplete.ParentId = newPost.Id;
        postComplete.Body = 'The requested action was successfully completed by Pebble_Post_Action. ' + '[' + newPost.Action__c + ']';
        
        //Create the URL for the Chatter Post if a Case or Chatter
        if (newPost.Action__c == 'Case' || newPost.Action__c == 'Chatter') {
            id15 = id15.substring(0, 15);
            postComplete.LinkUrl = 'https://' + system.URL.getSalesforceBaseUrl().getHost() +'/' + id15;
        }
        postComplete.Title = 'Pebble Post Action Completed';
        insert postComplete;
   

          
      //All done, just a blanket error handling update
      } catch (Exception e){
            System.debug('ERROR in Pebble_Post_Action:' + e);
            FeedItem postError = new FeedItem();
            postError.ParentId = newPost.Id;
            postError.Body = 'ERROR in Pebble_Post_Action:' + e;
            insert postError;
      }
}